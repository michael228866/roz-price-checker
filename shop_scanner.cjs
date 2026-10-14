const { SERVER_ID, listingKey } = require("./market.cjs");
const { collectPages } = require("./paginator.cjs");
const { captureShopResponse, captureShopLocation, enrichVisibleRows,
  matchesVisible } = require("./capture.cjs");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function scanKeywordPages(webContents, keyword, { isActive = () => true,
  wait = pause, targets = [], runId = 0, maxPages = 20,
  captureSearch = captureShopResponse, captureLocation = captureShopLocation,
  enrichRows = enrichVisibleRows, rowsMatch = matchesVisible } = {}) {
  return collectPages(async (pageNumber) => {
    if (!isActive()) throw new Error("SCAN_CANCELLED");
    if (pageNumber > 1) await wait(3000);
    const capture = await captureSearch(webContents, keyword,
      (pageNumber - 1) * 30 + 1);
    if (!capture) throw new Error("無法監聽官方查詢回應，已停止掃描。");
    try {
      capture.arm();
      const started = await webContents.executeJavaScript(`(() => {
        const page = ${pageNumber};
        const serverId = ${SERVER_ID};
        const server = document.querySelector('#div_svr');
        if (!server) return { error: '找不到伺服器選項。' };
        if (page === 1 && server.getAttribute('_val') !== String(serverId)) {
          const option = document.querySelector('.selectSrv li[value="' + serverId + '"]');
          if (!option) return { error: '找不到指定伺服器。' };
          server.click();
          option.click();
        }
        if (server.getAttribute('_val') !== String(serverId)) {
          return { error: '查詢頁目前不是 Server ID ' + serverId + '，已停止掃描。' };
        }
        const login = document.querySelector('#a_searchBtn');
        if (!login || login.textContent.includes('請先登入')) {
          return { error: '請先在查詢頁登入並完成網站驗證。' };
        }
        const tab = document.querySelector('#searchTab1');
        if (page === 1 && tab && !tab.checked) {
          document.querySelector('label[for="searchTab1"]')?.click();
        }
        if (tab && !tab.checked) return { error: '未切換至露天商店查詢。' };
        const input = document.querySelector('#txb_KeyWord');
        const body = document.querySelector('#_tbody');
        if (!input || !body) return { error: '找不到查詢欄位或結果區。' };
        window.__shopResultChanged = false;
        window.__shopResultObserver?.disconnect();
        window.__shopResultObserver = new MutationObserver(() => {
          window.__shopResultChanged = true;
        });
        window.__shopResultObserver.observe(body,
          { childList: true, subtree: true, characterData: true });
        const noResults = document.querySelector('#PoringCry1');
        if (noResults) window.__shopResultObserver.observe(noResults,
          { attributes: true, childList: true, subtree: true });
        if (page === 1) {
          input.value = ${JSON.stringify(keyword)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          const button = document.querySelector('#searchBtn');
          if (!button) return { error: '找不到查詢按鈕。' };
          button.click();
        } else {
          if (input.value !== ${JSON.stringify(keyword)}) {
            return { error: '分頁關鍵字與原搜尋不符。' };
          }
          const current = Number(document.querySelector('.pagination li.active a')?.textContent);
          const next = Array.from(document.querySelectorAll('.pagination a'))
            .find((link) => link.getAttribute('onclick') === 'javascript:goPage(' + page + ')');
          if (current !== page - 1 || !next) return { paginationUnavailable: true };
          next.click();
        }
        return { started: true };
      })()`);
      if (started?.paginationUnavailable) {
        return { items: [], reportedCount: null, hasNext: null };
      }
      if (started?.error) throw new Error(started.error);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await wait(500);
        if (!isActive()) throw new Error("SCAN_CANCELLED");
        const captured = capture.peek();
        if (captured.response?.rateLimited) {
          throw new Error("網站限制查詢（HTTP 403/429），掃描已停止。");
        }
        if (["ambiguous", "invalid"].includes(captured.status)) {
          throw new Error("查詢回應無法可靠配對，已停止掃描。");
        }
        const state = await webContents.executeJavaScript(`(() => {
          const page = ${pageNumber};
          const rows = Array.from(document.querySelectorAll('#_tbody tr'));
          const output = rows.filter(row => row.querySelectorAll('td').length >= 6)
            .map((row, rowIndex) => {
              const cells = Array.from(row.querySelectorAll('td'))
                .map(cell => cell.textContent.trim());
              return { rowIndex,
                ssi: row.querySelector('.shopName')?.getAttribute('SSI') || null,
                shop: cells[0], itemName: cells[1], slots: cells[2],
                price: Number(cells[3].replace(/[^0-9]/g, '')),
                quantity: Number(cells[4].replace(/[^0-9]/g, '')),
                storeType: cells[5] };
            });
          return { output,
            loading: rows.some(row => row.textContent.includes('請稍候')),
            activePage: Number(document.querySelector('.pagination li.active a')?.textContent),
            hasNextControl: Array.from(document.querySelectorAll('.pagination a'))
              .some(link => link.getAttribute('onclick') ===
                'javascript:goPage(' + (page + 1) + ')'),
            serverId: document.querySelector('#div_svr')?.getAttribute('_val'),
            messageText: document.querySelector('.swal2-html-container, .swal2-content')
              ?.textContent?.trim() || '' };
        })()`);
        if (state.messageText && /登入|驗證|驗證碼/.test(state.messageText)) {
          throw new Error(`網站要求處理：${state.messageText}`);
        }
        if (state.serverId !== String(SERVER_ID)) {
          throw new Error(`查詢頁伺服器不是 ${SERVER_ID}，已停止掃描。`);
        }
        if (captured.status !== "ready" || state.loading ||
            (pageNumber > 1 && state.activePage !== pageNumber) ||
            !rowsMatch(state.output, captured.response)) continue;
        const visible = enrichRows(state.output, captured.response)
          .map((row) => ({ ...row, serverId: SERVER_ID, keyword,
            pageNumber, observationKey: row.ssi ? null :
              `${runId}:${keyword}:${pageNumber}:${row.rowIndex}` }));
        capture.close();
        for (const target of targets) {
          const matches = visible.filter((row) => row.ssi && row.ssi === target.ssi &&
            row.shop === target.shop && row.itemName === target.itemName &&
            row.price === target.price && row.quantity === target.quantity &&
            row.specification === target.specification &&
            listingKey(row) === listingKey(target));
          if (matches.length !== 1) continue;
          target._confirmed = true;
          const row = matches[0];
          try {
            const request = { rowIndex: row.rowIndex, ssi: row.ssi,
              shop: row.shop, itemName: row.itemName, price: row.price,
              quantity: row.quantity };
            target.location = await captureLocation(webContents,
              { ...row, serverId: SERVER_ID }, () => webContents.executeJavaScript(`(() => {
                const target = ${JSON.stringify(request)};
                const tr = document.querySelectorAll('#_tbody tr')[target.rowIndex];
                const shop = tr?.querySelector('.shopName');
                const cells = tr ? Array.from(tr.querySelectorAll('td'))
                  .map(td => td.textContent.trim()) : [];
                if (!shop || shop.getAttribute('SSI') !== target.ssi ||
                    cells[0] !== target.shop || cells[1] !== target.itemName ||
                    Number(cells[3].replace(/[^0-9]/g, '')) !== target.price ||
                    Number(cells[4].replace(/[^0-9]/g, '')) !== target.quantity) return false;
                shop.click();
                return true;
              })()`));
            await webContents.executeJavaScript(
              "document.querySelector('.popup__itemInfo .close')?.click()");
          } catch { target.location = null; }
        }
        const count = captured.response.reportedCount;
        return { items: visible, reportedCount: count,
          hasNext: count === null ? null : count > pageNumber * 30
            ? (state.hasNextControl ? true : null) : false,
          countVerified: count !== null };
      }
      const captured = capture.peek();
      throw new Error(`「${keyword}」第 ${pageNumber} 頁查詢逾時：` +
        (captured.status === "ready" ? "搜尋回應與畫面資料不一致" :
          "網站未完成這次查詢，請確認登入與驗證"));
    } finally { capture.close(); }
  }, { maxPages });
}

module.exports = { scanKeywordPages };
