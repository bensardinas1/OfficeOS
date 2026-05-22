export const sampleAccounts = [
  {
    id: "personal",
    name: "Personal",
    accountType: "personal",
    provider: "gmail",
    myEmail: "ben@personal.com",
    prioritySenders: [],
    neverDelete: [{ type: "domain", value: "equinox.com" }],
    alwaysDelete: [{ type: "name", value: "LinkedIn", label: "LinkedIn notifications" }],
    scamPatterns: [],
    urgencyRules: { flags: [] },
    downrank: [],
  }
];

export const sampleTypeConfig = {
  business: {
    triageCategories: [
      { id: "action", label: "ACTION REQUIRED", actionable: true },
      { id: "fyi", label: "FYI" },
      { id: "ignore", label: "IGNORE", hidden: true }
    ],
    downrankDefaults: [],
    bulkSignalThreshold: 2,
    deletionPolicy: { categories: ["ignore"], patterns: [], neverDelete: [], alwaysDelete: [] }
  },
  personal: {
    triageCategories: [
      { id: "respond", label: "RESPOND", actionable: true },
      { id: "newsletters", label: "NEWSLETTERS" },
      { id: "shopping", label: "SHOPPING" },
      { id: "ignore", label: "IGNORE", hidden: true }
    ],
    downrankDefaults: [],
    bulkSignalThreshold: 1,
    deletionPolicy: { categories: ["ignore"], patterns: [], neverDelete: [], alwaysDelete: [] },
    noiseFilters: null
  }
};

export const sampleEmails = {
  personal: [
    { id: "m1", from: "noreply@linkedin.com", fromName: "LinkedIn", subject: "Your weekly digest", hasListUnsubscribe: true, receivedAt: "2026-05-21T05:00:00Z" },
    { id: "m2", from: "noreply@equinox.com", fromName: "Equinox", subject: "Your account info", hasListUnsubscribe: true, receivedAt: "2026-05-21T05:30:00Z" },
    { id: "m3", from: "george@healthcarema.com", fromName: "George Gabela", subject: "URGENT: review LOI", hasListUnsubscribe: false, receivedAt: "2026-05-21T05:45:00Z" }
  ]
};
