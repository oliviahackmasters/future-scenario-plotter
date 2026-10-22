export const SCORE_DESCRIPTION = "Relative scenario scores sum to 100. They describe fit to the available evidence, not calibrated probabilities. No forecast horizon is specified.";

export function relativeScores(items, names) {
  const byName = new Map(items.map(item => [String(item.name || "").toLowerCase(), item]));
  const raw = names.map(name => (Number.isFinite(Number(byName.get(name.toLowerCase())?.score)) ? Math.max(0, Number(byName.get(name.toLowerCase())?.score)) : 0));
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map(value => total > 0 ? value / total * 100 : 0);
}

export function completeSignals(config, signals, articles, externalSignals) {
  const articleUrls = new Set(articles.map(article => article.url));
  const byName = new Map(signals.map(signal => [signal.name, signal]));
  const externalByName = new Map(externalSignals.filter(item => item.signal).map(item => [item.signal.name, item.signal]));
  return config.trackedSignals.map(name => {
    const external = externalByName.get(name);
    if (external) return {
      ...external,
      evidence_status: external.evidence_status || (external.sources?.length ? "supported" : "insufficient")
    };
    const signal = byName.get(name);
    const sources = (Array.isArray(signal?.sources) ? signal.sources : []).filter(source => articleUrls.has(source.url));
    if (!sources.length || signal?.evidence_status === "insufficient") {
      return { name, reading: "Unknown: insufficient evidence in the sources checked. This does not establish stability or absence of risk.", direction: "neutral", confidence: "Low", evidence_status: "insufficient", sources: [] };
    }
    return { ...signal, sources, evidence_status: "supported" };
  });

}

export function monthlyOilSignal(data, now = new Date()) {
  const series = (Array.isArray(data.data) ? data.data : [])
    .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date || "") && Number.isFinite(Number(item.value)) && Number(item.value) > 0)
    .sort((a, b) => b.date.localeCompare(a.date));
  const latest = series[0];
  const previous = series[1];
  const source = { title: "Brent crude monthly averages (USD per barrel)", url: "https://www.alphavantage.co/documentation/#brent", source: "Alpha Vantage" };
  if (!latest) return { source: "Alpha Vantage", status: "unavailable", latest: null, interval: "monthly", signal: { name: "oil prices", reading: "Unknown: no valid dated monthly Brent observations were returned.", direction: "neutral", confidence: "Low", evidence_status: "insufficient", sources: [] } };
  const ageDays = Math.floor((now - new Date(latest.date)) / 86400000);
  const stale = ageDays > 62 || ageDays < 0;
  const value = Number(latest.value);
  const previousValue = previous ? Number(previous.value) : null;
  const delta = previousValue ? (value - previousValue) / previousValue * 100 : null;
  const direction = stale || delta === null ? "neutral" : value >= 85 || delta >= 8 ? "escalatory" : value <= 70 && delta <= -5 ? "de-escalatory" : "neutral";
  return {
    source: "Alpha Vantage", status: stale ? "stale" : "ok", interval: "monthly", unit: "USD/bbl", latest: value, previous: previousValue,
    observation_date: latest.date, previous_observation_date: previous?.date || null,
    signal: { name: "oil prices", reading: `${stale ? "Stale data. " : ""}Brent monthly average for ${latest.date.slice(0, 7)}: ${value.toFixed(2)} USD/bbl${previous ? `; ${previous.date.slice(0, 7)}: ${previousValue.toFixed(2)} USD/bbl` : "; no prior observation available"}. This is a monthly average, not a live price.`, direction, confidence: "Low", evidence_status: stale ? "insufficient" : "supported", sources: [source] }
  };
}
