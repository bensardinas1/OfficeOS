export const businessTypeConfig = {
  tone: "professional",
  triageCategories: [
    { id: "action", label: "ACTION REQUIRED", description: "Needs a response or decision" },
    { id: "fyi", label: "FYI / READ", description: "Informational, no action needed" },
    { id: "news", label: "NEWS / MARKET", description: "Industry or market updates" },
    { id: "ignore", label: "IGNORE", hidden: true }
  ],
  downrankDefaults: ["bulk email", "newsletters", "marketing", "solicitations", "unsubscribe", "promotional"],
  noiseFilters: null,
  dailyBrief: { section: "main" },
  taskCapture: "auto"
};

export const personalTypeConfig = {
  tone: "casual",
  triageCategories: [
    { id: "respond", label: "RESPOND", description: "Needs a reply" },
    { id: "bills", label: "BILLS / FINANCE", description: "Bills due, statements, bank alerts" },
    { id: "appointments", label: "APPOINTMENTS", description: "Medical, dental, personal services" },
    { id: "shopping", label: "SHOPPING / ORDERS", description: "Order confirmations, shipping" },
    { id: "subscriptions", label: "SUBSCRIPTIONS / RENEWALS", description: "Renewal notices" },
    { id: "newsletters", label: "NEWSLETTERS", description: "Opted-in reads" },
    { id: "ignore", label: "IGNORE", hidden: true }
  ],
  downrankDefaults: [
    "promotional", "unsubscribe", "deal alert", "limited time", "flash sale",
    "exclusive offer", "free shipping", "items you might like"
  ],
  noiseFilters: {
    signals_keep: ["confirmation", "receipt", "shipped", "delivered", "reminder",
                   "appointment", "invoice", "due", "renewal", "booking", "payment"],
    signals_reject: ["promotion", "deal", "offer", "recommended", "trending",
                     "you might like", "earn", "reward points", "upgrade"]
  },
  dailyBrief: { section: "personal-appendix" },
  taskCapture: "manual"
};

export const businessAccount = {
  id: "testbiz",
  name: "Test Business",
  accountType: "business",
  provider: "outlook",
  prioritySenders: [
    { type: "domain", value: "testbiz.com", label: "Internal" },
    { type: "name", value: "Jane Partner", label: "Partner" }
  ],
  urgencyRules: {
    flags: ["urgent", "deadline", "review", "terminated"]
  },
  downrank: ["solicitation"],
  categoryOverrides: []
};

export const personalAccount = {
  id: "testpersonal",
  name: "Personal",
  accountType: "personal",
  provider: "gmail",
  prioritySenders: [],
  urgencyRules: { flags: [] },
  downrank: [],
  categoryOverrides: [
    {
      id: "iaido",
      label: "IAIDO",
      description: "Iaido study and competition",
      prioritySenders: [{ type: "domain", value: "auskf.org", label: "National federation" }],
      urgencyRules: { flags: ["tournament", "registration", "deadline", "grading"] },
      downrank: ["merchandise"]
    }
  ]
};
