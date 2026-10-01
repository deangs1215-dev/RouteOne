// Plain-language explanations for the Sales intelligence labels. Keep in step with the rules in
// server/routes/intelligence.routes.js.
export const SEGMENT_HELP = {
  'Champion': 'Orders often and recently, well within their normal buying cycle. Your best customers - keep them happy.',
  'Loyal': 'Orders regularly and is still within their normal buying cycle. Look for chances to grow their basket.',
  'New / promising': 'Ordered recently but not yet often. Build the habit with a follow-up visit.',
  'Needs attention': 'Has gone past their usual buying cycle without ordering. A visit or call now can stop them drifting away.',
  "Can't lose": 'Has stopped ordering recently, but used to buy often or spend a lot. High value and slipping away - prioritise a call or visit.',
  'At risk': 'Has gone quiet for well over their normal cycle, with only occasional orders before. Find out why they stopped.',
  'Hibernating': 'No recent orders and little history over the last 180 days. Low priority unless there is a reason to win them back.'
};

export const RISK_HELP = 'Churn risk (0-100): how likely this customer is to stop buying. Built from how overdue they are against their normal buying cycle (up to 45), how far spend has dropped versus the previous quarter (up to 35) and whether they had missed visits in the last 90 days (20). 70+ is high, 40-69 medium, under 40 low. Never invoiced scores 85.';

export const RFM_HELP = 'R·F·M scores, each 1-5 (5 is best). R = Recency: how recently they were invoiced compared with their normal buying cycle. F = Frequency: number of invoices in the last 180 days. M = Monetary: how much they spent in the last 180 days, ranked against all customers.';

// Customer grade (A/B/C) is set by hand on the customer record - there is no automatic rule behind it.
export const GRADE_HELP = {
  A: 'Top account. Highest value to the business - visit most often and protect the relationship.',
  B: 'Standard account. Steady buyer with room to grow - visit on the normal cycle.',
  C: 'Smaller or occasional account. Lowest priority for visits - keep in touch without over-investing time.'
};
