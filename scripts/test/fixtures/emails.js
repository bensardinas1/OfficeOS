export const emails = {
  // Business emails
  fromInternalDomain: {
    id: "e1", subject: "Q2 Report", from: "alice@testbiz.com",
    fromName: "Alice Smith", preview: "Please review the attached Q2 report", received: "2026-03-14T10:00:00Z"
  },
  fromPrioritySenderByName: {
    id: "e2", subject: "Call me", from: "jane@external.com",
    fromName: "Jane Partner", preview: "Can we talk?", received: "2026-03-14T10:01:00Z"
  },
  withUrgencyFlag: {
    id: "e3", subject: "Account terminated", from: "processor@bank.com",
    fromName: "Bank", preview: "Account has been terminated effective immediately", received: "2026-03-14T10:02:00Z"
  },
  newsletter: {
    id: "e4", subject: "Weekly IT Newsletter", from: "news@substack.com",
    fromName: "IT News", preview: "Top articles this week", received: "2026-03-14T10:03:00Z"
  },
  marketing: {
    id: "e5", subject: "Drive revenue with our product", from: "sales@vendor.com",
    fromName: "Vendor", preview: "Promotional offer inside", received: "2026-03-14T10:04:00Z"
  },
  downrankedByAccount: {
    id: "e6", subject: "Solicitation for your business", from: "cold@spam.com",
    fromName: "Spam Co", preview: "solicitation for your attention", received: "2026-03-14T10:05:00Z"
  },
  fyi: {
    id: "e7", subject: "FYI: Office closed Monday", from: "admin@other.com",
    fromName: "Admin", preview: "Just letting you know the office is closed", received: "2026-03-14T10:06:00Z"
  },
  // Personal emails
  chaseStatement: {
    id: "p1", subject: "Your statement is ready", from: "no.reply@chase.com",
    fromName: "Chase", preview: "Statement balance due on 04/10/2026 payment required", received: "2026-03-14T11:00:00Z"
  },
  uberEatsDeal: {
    id: "p2", subject: "50% off your next order — deal expires tonight",
    from: "promotions@uber.com", fromName: "Uber Eats",
    preview: "Exclusive deal offer: 50% off", received: "2026-03-14T11:01:00Z"
  },
  iaidoFromFederation: {
    id: "p3", subject: "2026 Tournament Registration", from: "events@auskf.org",
    fromName: "AUSKF", preview: "Registration deadline for the national tournament", received: "2026-03-14T11:02:00Z"
  },
  iaidoMerchandise: {
    id: "p4", subject: "New merchandise available", from: "shop@auskf.org",
    fromName: "AUSKF Shop", preview: "New merchandise in the store", received: "2026-03-14T11:03:00Z"
  },
  shippingConfirmation: {
    id: "p5", subject: "Your order has shipped", from: "orders@amazon.com",
    fromName: "Amazon", preview: "confirmation: your package has been shipped and delivered", received: "2026-03-14T11:04:00Z"
  },
  retailPromo: {
    id: "p6", subject: "New arrivals — items you might like",
    from: "promo@store.com", fromName: "Store",
    preview: "Recommended for you: new arrivals", received: "2026-03-14T11:05:00Z"
  }
};
