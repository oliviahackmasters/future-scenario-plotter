export const SOURCE_CATALOG = [
  {
    name: "Reuters World",
    aliases: ["reuters", "reuters world", "reuters news"],
    homepage: "https://www.reuters.com/world/",
    feedUrl: "https://feeds.reuters.com/Reuters/worldNews"
  },
  {
    name: "BBC Middle East",
    aliases: ["bbc middle east", "bbc mideast"],
    homepage: "https://www.bbc.com/news/world/middle_east",
    feedUrl: "http://feeds.bbci.co.uk/news/world/middle_east/rss.xml"
  },
  {
    name: "BBC World",
    aliases: ["bbc world", "bbc news world"],
    homepage: "https://www.bbc.com/news/world",
    feedUrl: "http://feeds.bbci.co.uk/news/world/rss.xml"
  },
  {
    name: "Financial Times Energy",
    aliases: ["ft energy", "financial times energy"],
    homepage: "https://www.ft.com/energy",
    feedUrl: "https://www.ft.com/energy?format=rss"
  },
  {
    name: "Financial Times Oil",
    aliases: ["ft oil", "financial times oil"],
    homepage: "https://www.ft.com/oil",
    feedUrl: "https://www.ft.com/oil?format=rss"
  },
  {
    name: "Al Jazeera",
    aliases: ["al jazeera", "aljazeera"],
    homepage: "https://www.aljazeera.com/",
    feedUrl: "https://www.aljazeera.com/xml/rss/all.xml"
  },
  {
    name: "The Guardian World",
    aliases: ["guardian world", "the guardian world", "guardian"],
    homepage: "https://www.theguardian.com/world",
    feedUrl: "https://www.theguardian.com/world/rss"
  }
];

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function findCatalogSourceByName(name) {
  const target = normalize(name);
  if (!target) return null;

  for (const item of SOURCE_CATALOG) {
    if (normalize(item.name) === target) return item;
    if ((item.aliases || []).some((alias) => normalize(alias) === target)) return item;
  }

  return null;
}