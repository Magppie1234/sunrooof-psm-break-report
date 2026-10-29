(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BreakMetrics = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const key = value => String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const systems = new Set(['sipdisconnected', 'sipdisconnect', 'changemode', 'refresh', 'reconnect',
    'agentbrowserrefresh', 'logoffbyagent', 'logoffbyadmin', 'forcereleasebyagent']);
  const unknowns = new Set(['', 'break', 'pause', 'aux', 'release', 'ready', 'idle', 'reasonunavailable', 'unknown', 'na', 'n/a', 'null', 'undefined']);
  const isSystem = reason => systems.has(key(reason));
  const isNamed = reason => !isSystem(reason) && !unknowns.has(key(reason));
  function reasonOf(event) {
    const values = [event.eventData, event.miscDetails].map(v => String(v || '').trim());
    // Reconnect metadata must not replace an explicit Lunch/Rest Room reason.
    return values.find(isNamed) || values.find(isSystem) || 'Reason unavailable';
  }
  function stamp(value, date) {
    if (typeof value !== 'string' || !value.trim()) return NaN;
    if (/^\d{2}:\d{2}:\d{2}$/.test(value)) value = date + 'T' + value + '+05:30';
    else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) value = value.replace(' ', 'T') + '+05:30';
    return Date.parse(value);
  }
  function seconds(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : 0;
    if (/^\d+(?:\.\d+)?$/.test(String(value||''))) return Number(value);
    if (!/^\d+:\d{2}:\d{2}$/.test(String(value || ''))) return 0;
    return value.split(':').map(Number).reduce((n, p) => n * 60 + p, 0);
  }
  function duration(row, now = Date.now()) {
    if (row.countedSeconds != null) return Math.max(0, Number(row.countedSeconds) || 0);
    if (row.incomplete || row.ongoing === false && !row.end) return 0;
    const start = stamp(row.start, row.date), end = row.end ? stamp(row.end, row.date) : now;
    return Number.isFinite(start) && Number.isFinite(end) && end >= start && start <= now
      ? Math.max(0, Math.floor((Math.min(end, now) - start) / 1000)) : 0;
  }
  return {key, isSystem, isNamed, reasonOf, stamp, seconds, duration};
});
