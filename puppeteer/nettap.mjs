/** Start taps for multiple regex patterns; returns { stop(), waitForQuiet(), hits } */
export async function startMultiTap(page, patterns = []) {
  const hits = [];
  const matchers = patterns.map(rx => (url) => rx.test(url));

  // We do NOT enable request interception; we *listen*
  const onRequest = async (req) => {
    try {
      const url = req.url();
      if (!matchers.some(m => m(url))) return;

      const method = req.method();
      const postDataRaw = req.postData() || null;

      let bodyJson = null, bodyForm = null;
      if (postDataRaw) {
        try { bodyJson = JSON.parse(postDataRaw); }
        catch {
          if (postDataRaw.includes('=') && postDataRaw.includes('&')) {
            bodyForm = Object.fromEntries(new URLSearchParams(postDataRaw));
          }
        }
      }

      const record = {
        request: { url, method, headers: req.headers(), postDataRaw, bodyJson, bodyForm },
        response: null,
        ts: Date.now()
      };

      hits.push(record);

      // Attach response body when it arrives
      req.response()?.text().then(txt => {
        try { record.response = { status: req.response()?.status() || null, body: tryJson(txt) }; }
        catch { record.response = { status: req.response()?.status() || null, body: txt }; }
      }).catch(() => {});
    } catch {}
  };

  page.on('requestfinished', onRequest);

  let lastLen = 0, lastTs = Date.now();
  const touch = () => { if (hits.length !== lastLen) { lastLen = hits.length; lastTs = Date.now(); }};
  const interval = setInterval(touch, 250);

  function tryJson(s) { try { return JSON.parse(s); } catch { return s; } }

  return {
    hits,
    stop() {
      clearInterval(interval);
      page.off('requestfinished', onRequest);
      return hits.slice();
    },
    async waitForQuiet(quietMs = 2000, maxMs = 15000) {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        if (Date.now() - lastTs >= quietMs) break;
        await new Promise(r => setTimeout(r, 150));
      }
      return hits.slice();
    }
  };
}
