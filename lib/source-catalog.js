export const SOURCE_CATALOG = [
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
    aliases: ["ft energy", "financial times energy", "energy crisis", "energy feed"],
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
  },
  {
    name: "Reuters World",
    aliases: ["reuters", "reuters world", "reuters news"],
    homepage: "https://www.reuters.com/world/",
    feedUrl: "https://feeds.reuters.com/Reuters/worldNews"
  },
  {
    name: "Google News – Iran",
    aliases: ["google news iran", "google news search iran", "iran google news"],
    homepage: "https://news.google.com/search?q=iran",
    feedUrl: "https://news.google.com/rss/search?q=iran&hl=en-US&gl=US&ceid=US:en"
  },
  {
    name: "Google News – Iran war",
    aliases: ["google news iran war", "iran war google news"],
    homepage: "https://news.google.com/search?q=iran+war",
    feedUrl: "https://news.google.com/rss/search?q=iran+war&hl=en-US&gl=US&ceid=US:en"
  },
  {
    name: "Google News – Iran Israel",
    aliases: ["google news iran israel", "iran israel google news"],
    homepage: "https://news.google.com/search?q=iran+israel",
    feedUrl: "https://news.google.com/rss/search?q=iran+israel&hl=en-US&gl=US&ceid=US:en"
  },
  {
    name: "Reddit search – Iran",
    aliases: ["reddit iran", "reddit search iran"],
    homepage: "https://www.reddit.com/search/?q=iran",
    feedUrl: "https://www.reddit.com/search.rss?q=iran"
  },
  {
    name: "Reddit search – Iran war",
    aliases: ["reddit iran war", "reddit search iran war"],
    homepage: "https://www.reddit.com/search/?q=iran+war",
    feedUrl: "https://www.reddit.com/search.rss?q=iran+war"
  },
  {
    name: "Reddit search – Iran Israel",
    aliases: ["reddit iran israel", "reddit search iran israel"],
    homepage: "https://www.reddit.com/search/?q=iran+israel",
    feedUrl: "https://www.reddit.com/search.rss?q=iran+israel"
  },
  {
    name: "Reddit search – Hormuz",
    aliases: ["reddit hormuz", "reddit search hormuz"],
    homepage: "https://www.reddit.com/search/?q=hormuz",
    feedUrl: "https://www.reddit.com/search.rss?q=hormuz"
  },
  {
    name: "Tehran Times",
    aliases: ["tehran times", "tehran times rss"],
    homepage: "https://www.tehrantimes.com/",
    feedUrl: "https://www.tehrantimes.com/rss"
  },
  {
    name: "Mehr News English",
    aliases: ["mehr news", "mehr english", "mehr rss"],
    homepage: "https://en.mehrnews.com/",
    feedUrl: "https://en.mehrnews.com/rss"
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