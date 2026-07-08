// Starter field-forms surfaced as customer/visit actions in the rep app
// (the "+ Add" menu). Seeded idempotently on boot - admins refine the fields
// on the Forms admin page; these are sensible starting points, not final specs.
//
// Field types supported by the form engine: text | number | select | checkbox | photo.
// (Dates use text with a format hint, since the engine has no date type yet.)
import { db } from './db.js';

const UOM = ['kg', 'bag', 'tub', 'box', 'each'];

const DEFAULT_FORMS = [
  {
    name: 'Technical Assistance Request',
    description: 'Log a technical/application issue for the tech team to follow up.',
    fields: [
      { key: 'product_code', label: 'Product code', type: 'text', required: true },
      { key: 'area', label: 'Problem area', type: 'select', required: true, options: ['Dough handling', 'Proofing / fermentation', 'Baking result', 'Shelf life', 'Equipment', 'Recipe / formulation', 'Other'] },
      { key: 'description', label: 'Description of issue', type: 'text', required: true },
      { key: 'urgency', label: 'Urgency', type: 'select', options: ['Low', 'Medium', 'High'] },
      { key: 'photo', label: 'Photo', type: 'photo' }
    ]
  },
  {
    name: 'Demonstration & Training',
    description: 'Request or record a product demo / training session.',
    fields: [
      { key: 'topic', label: 'Topic / product', type: 'text', required: true },
      { key: 'attendees', label: 'Expected attendees', type: 'number' },
      { key: 'preferred_date', label: 'Preferred date (YYYY-MM-DD)', type: 'text' },
      { key: 'objective', label: 'Objective / notes', type: 'text' }
    ]
  },
  {
    name: 'Sample Requisition',
    description: 'Request product samples for a customer.',
    fields: [
      { key: 'product_code', label: 'Product code', type: 'text', required: true },
      { key: 'product_name', label: 'Product name', type: 'text', required: true },
      { key: 'quantity', label: 'Quantity', type: 'number', required: true },
      { key: 'uom', label: 'Unit', type: 'select', options: UOM },
      { key: 'reason', label: 'Reason', type: 'select', required: true, options: ['New product trial', 'Quality check', 'Customer request', 'Demo / training', 'Other'] },
      { key: 'notes', label: 'Notes', type: 'text' }
    ]
  },
  {
    name: 'Sales Value & Volume Intel',
    description: 'Competitor / market intelligence gathered on site.',
    fields: [
      { key: 'competitor', label: 'Competitor', type: 'text' },
      { key: 'product_category', label: 'Product category', type: 'text' },
      { key: 'est_monthly_volume', label: 'Est. monthly volume', type: 'number' },
      { key: 'competitor_price', label: 'Competitor price (R)', type: 'number' },
      { key: 'notes', label: 'Notes', type: 'text' }
    ]
  },
  {
    name: 'Quality Complaint Form',
    description: 'Capture a product quality complaint.',
    fields: [
      { key: 'product_code', label: 'Product code', type: 'text', required: true },
      { key: 'batch_lot', label: 'Batch / lot number', type: 'text', required: true },
      { key: 'purchase_date', label: 'Date of purchase (YYYY-MM-DD)', type: 'text' },
      { key: 'nature', label: 'Nature of complaint', type: 'select', required: true, options: ['Foreign object', 'Off smell / taste', 'Texture / consistency', 'Mould / spoilage', 'Packaging', 'Underweight', 'Other'] },
      { key: 'description', label: 'Description', type: 'text', required: true },
      { key: 'qty_affected', label: 'Quantity affected', type: 'text' },
      { key: 'action_requested', label: 'Action requested', type: 'select', options: ['Replacement', 'Credit', 'Investigation', 'Collection'] },
      { key: 'photo', label: 'Photo', type: 'photo' }
    ]
  },
  {
    name: 'Food Safety Complaint Form',
    description: 'Capture a food-safety complaint (hazard-related).',
    fields: [
      { key: 'product_code', label: 'Product code', type: 'text', required: true },
      { key: 'batch_lot', label: 'Batch / lot number', type: 'text', required: true },
      { key: 'hazard_type', label: 'Hazard type', type: 'select', required: true, options: ['Biological', 'Chemical', 'Physical', 'Allergen', 'Other'] },
      { key: 'description', label: 'Description', type: 'text', required: true },
      { key: 'illness_reported', label: 'Illness reported', type: 'checkbox' },
      { key: 'qty_affected', label: 'Quantity affected', type: 'text' },
      { key: 'photo', label: 'Photo', type: 'photo' }
    ]
  },
  {
    name: 'Quality Investigation Report',
    description: 'Investigation findings for a quality complaint.',
    fields: [
      { key: 'reference', label: 'Related complaint ref', type: 'text' },
      { key: 'product_code', label: 'Product code', type: 'text', required: true },
      { key: 'batch_lot', label: 'Batch / lot number', type: 'text' },
      { key: 'findings', label: 'Findings', type: 'text', required: true },
      { key: 'root_cause', label: 'Root cause', type: 'text' },
      { key: 'corrective_action', label: 'Corrective action', type: 'text' },
      { key: 'status', label: 'Status', type: 'select', options: ['Open', 'In progress', 'Closed'] },
      { key: 'photo', label: 'Photo', type: 'photo' }
    ]
  },
  {
    name: 'Food Safety Investigation Report',
    description: 'Investigation findings for a food-safety complaint.',
    fields: [
      { key: 'reference', label: 'Related complaint ref', type: 'text' },
      { key: 'product_code', label: 'Product code', type: 'text', required: true },
      { key: 'batch_lot', label: 'Batch / lot number', type: 'text' },
      { key: 'hazard_type', label: 'Hazard type', type: 'select', options: ['Biological', 'Chemical', 'Physical', 'Allergen', 'Other'] },
      { key: 'findings', label: 'Findings', type: 'text', required: true },
      { key: 'root_cause', label: 'Root cause', type: 'text' },
      { key: 'corrective_action', label: 'Corrective action', type: 'text' },
      { key: 'status', label: 'Status', type: 'select', options: ['Open', 'In progress', 'Closed'] },
      { key: 'photo', label: 'Photo', type: 'photo' }
    ]
  },
  {
    name: 'Collection Advice Note',
    description: 'Advise a collection / uplift of product from the customer.',
    fields: [
      { key: 'product_code', label: 'Product code', type: 'text', required: true },
      { key: 'batch_lot', label: 'Batch / lot number', type: 'text' },
      { key: 'quantity', label: 'Quantity', type: 'number', required: true },
      { key: 'uom', label: 'Unit', type: 'select', options: UOM },
      { key: 'reason', label: 'Reason', type: 'select', required: true, options: ['Quality issue', 'Recall', 'Expired', 'Customer return', 'Over-supply', 'Other'] },
      { key: 'collection_date', label: 'Collection date (YYYY-MM-DD)', type: 'text' },
      { key: 'notes', label: 'Notes', type: 'text' }
    ]
  },
  {
    name: 'Follow-up Task',
    description: 'Log a follow-up task / reminder for this customer.',
    fields: [
      { key: 'title', label: 'Task', type: 'text', required: true },
      { key: 'due_date', label: 'Due date (YYYY-MM-DD)', type: 'text' },
      { key: 'priority', label: 'Priority', type: 'select', options: ['Low', 'Medium', 'High'] },
      { key: 'details', label: 'Details', type: 'text' }
    ]
  }
];

// Insert any default form that doesn't already exist (matched by name), so both
// fresh and existing databases get them and re-runs never duplicate.
export function ensureDefaultForms() {
  const exists = db.prepare('SELECT 1 FROM form_templates WHERE name = ?');
  const insert = db.prepare('INSERT INTO form_templates (name, description, fields, active) VALUES (?, ?, ?, 1)');
  let added = 0;
  for (const f of DEFAULT_FORMS) {
    if (!exists.get(f.name)) {
      insert.run(f.name, f.description || null, JSON.stringify(f.fields));
      added++;
    }
  }
  if (added) console.log(`[forms] seeded ${added} default field form(s)`);
}
