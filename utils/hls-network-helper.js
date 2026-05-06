// Records timing for HLS segment / playlist requests. Mirrors the
// `this.net` array from the customer's _wire() method.

function attachHlsNetworkRecorder(page) {
  const records = [];
  page.on("request", (r) => {
    if (/\.(ts|m3u8)(\?|$)/.test(r.url())) {
      records.push({ url: r.url(), t0: Date.now() });
    }
  });
  page.on("response", (r) => {
    const rec = records.find((x) => x.url === r.url() && x.t1 == null);
    if (rec) {
      rec.t1 = Date.now();
      rec.ms = rec.t1 - rec.t0;
      rec.status = r.status();
    }
  });
  return {
    records: () => records.slice(),
  };
}

module.exports = { attachHlsNetworkRecorder };
