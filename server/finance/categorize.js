// Transaction categorisation: provider category first, then merchant/description rules.
export const CATEGORIES = ["food", "shopping", "transport", "fuel", "bills", "subscriptions", "entertainment", "travel", "transfers", "income", "other"];

const MONZO_MAP = {
  eating_out: "food", groceries: "food",
  shopping: "shopping", personal_care: "shopping", family: "shopping", gifts: "shopping", charity: "other",
  transport: "transport",
  bills: "bills", finances: "bills",
  entertainment: "entertainment",
  holidays: "travel",
  transfers: "transfers", savings: "transfers",
  income: "income",
  general: "other", expenses: "other", cash: "other",
};

const RULES = [
  ["fuel", /\b(shell|bp |esso|texaco|jet |gulf|fuel|petrol|diesel|sainsbury'?s petrol|tesco petrol|asda petrol|mfg|applegreen)\b/i],
  ["subscriptions", /\b(netflix|spotify|disney\+?|apple\.com\/bill|itunes|icloud|amazon prime|prime video|youtube premium|now tv|patreon|chatgpt|openai|anthropic|claude\.ai|microsoft 365|adobe|dropbox|audible|xbox game pass|playstation plus|gym|puregym|the gym group)\b/i],
  ["food", /\b(tesco|sainsbury|asda|morrisons|aldi|lidl|waitrose|co-?op|m&s food|iceland|greggs|pret|costa|starbucks|mcdonald|kfc|burger king|subway|nando|deliveroo|just eat|uber \*?eats|domino|pizza|cafe|restaurant)\b/i],
  ["transport", /\b(uber(?! \*?eats)|bolt|trainline|tfl|national rail|lner|avanti|gwr|northern rail|stagecoach|arriva|first bus|parking|ringgo|paybyphone|dvla)\b/i],
  ["travel", /\b(ryanair|easyjet|jet2|british airways|tui|booking\.com|airbnb|expedia|hotels\.com|premier inn|travelodge|hilton|marriott)\b/i],
  ["bills", /\b(council tax|octopus|british gas|edf|e\.on|ovo|bulb|thames water|severn trent|united utilities|anglian water|bt |sky |virgin media|vodafone|ee |o2 |three|giffgaff|tv licen[cs]e|insurance|rent|mortgage)\b/i],
  ["entertainment", /\b(cinema|odeon|vue|cineworld|steam|playstation|xbox|nintendo|ticketmaster|eventbrite|bowling|pub|bar )\b/i],
  ["shopping", /\b(amazon|ebay|argos|currys|john lewis|next|primark|h&m|zara|asos|boots|superdrug|ikea|b&q|apple store)\b/i],
];

/** Returns a JARVIS category for a normalised transaction. Internal transfers are always "transfers". */
export function categorize({ description = "", merchant = "", providerCategory = "", amount = 0, internal = false }) {
  if (internal) return "transfers";
  const text = `${merchant} ${description}`;
  for (const [cat, re] of RULES) if (re.test(text)) return cat;
  if (amount > 0) return providerCategory === "transfers" ? "transfers" : "income";
  return MONZO_MAP[providerCategory] || "other";
}
