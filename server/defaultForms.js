// Standard field-forms surfaced as customer/visit actions in the rep app
// (the "+ Add" menu). These mirror Bakels' paper forms. Admins can refine them
// on the Forms admin page afterwards.
//
// Field types supported by the form engine:
//   heading  - non-input section divider (label = section title)
//   text     - free text
//   email    - email address (email keyboard)
//   number   - numeric
//   date     - date picker
//   select   - dropdown / radio (needs `options`)
//   checkbox - single yes/no tick
//   photo    - camera / image upload
//   signature- on-screen signature pad
//   product  - product-catalogue picker
//
// Seeding is version-gated: bump SEED_VERSION to wipe the old templates and
// reinstall this set on the next boot (see ensureDefaultForms below).
import { dbx } from './db.js';
import { getSetting, setSetting } from './dbh.js';

const SEED_VERSION = '2026-07-bakels-forms-1';

// Reusable option lists.
const BRANCHES = [
  'JOHANNESBURG DESPATCH', 'CAPE TOWN FG', 'PIETERMARITZBURG FG', 'PIETERMARITZBURG PROD',
  'EAST LONDON', 'PORT ELIZABETH', 'POLOKWANE', 'NELSPRUIT', 'BLOEMFONTEIN', 'H/O DISTRIBUTION'
];
const COMPLAINT_TYPES = [
  'Foreign object', 'Off smell / taste', 'Texture / consistency', 'Mould / spoilage',
  'Packaging', 'Underweight', 'Short shelf life', 'Other'
];
const YES_NO = ['Yes', 'No'];
const YES_NO_NA = ['Yes', 'No', 'N/A'];

// Field builders (each field needs a unique key within its form).
const h = (key, label) => ({ key, label, type: 'heading' });
const text = (key, label, required = false) => ({ key, label, type: 'text', required });
const email = (key, label) => ({ key, label, type: 'email' });
const date = (key, label) => ({ key, label, type: 'date' });
const photo = (key, label) => ({ key, label, type: 'photo' });
const sign = (key, label) => ({ key, label, type: 'signature' });
const product = (key, label) => ({ key, label, type: 'product' });
const select = (key, label, options, required = false) => ({ key, label, type: 'select', options, required });

const DEFAULT_FORMS = [
  // 2 ---------------------------------------------------------------------
  {
    name: 'Demonstration & Training',
    description: 'Record a product demonstration / training session.',
    fields: [
      text('facilities', 'What facilities are available'),
      date('demo_date', 'Demo date'),
      date('training_from', 'Training done from'),
      date('training_to', 'To'),
      product('products_demonstrated', 'Which products are to be demonstrated'),
      text('results', 'Results of demo'),
      text('present_1', '1. Present at training'),
      text('id_1', '1. I.D number'),
      text('group_1', '1. Designated group'),
      text('present_2', '2. Present at training'),
      text('id_2', '2. I.D number'),
      text('group_2', '2. Designated group'),
      text('present_3', '3. Present at training'),
      text('id_3', '3. I.D number'),
      text('group_3', '3. Designated group'),
      text('present_4', '4. Present at training'),
      text('id_4', '4. I.D number'),
      text('group_4', '4. Designated group'),
      text('present_5', '5. Present at training'),
      text('id_5', '5. I.D number'),
      text('group_5', '5. Designated group'),
      text('order_placed', 'Order placed: Yes / No - if yes, please list products'),
      product('order_products', 'If Yes - add product'),
      text('demo_requested_by', 'Demo requested by'),
      date('date', 'Date'),
      text('demonstrators_name', 'Demonstrators name'),
      h('customer_section', 'To be completed by customer'),
      select('demo_on_time', 'Was the demo on time?', YES_NO),
      select('demo_good', 'Was the product demonstration good?', YES_NO),
      select('interested_other', 'Are you interested in other products?', YES_NO),
      select('placed_order', 'Did you place an order?', YES_NO),
      text('customer_name', 'Customer name'),
      sign('signature', 'Signature')
    ]
  },

  // 3 ---------------------------------------------------------------------
  {
    name: 'Sample Requisition',
    description: 'Request product samples for a customer.',
    fields: [
      product('product_1', '1. Product'),
      text('sample_kg_1', '1. Sample/kg'),
      product('product_2', '2. Product'),
      text('sample_kg_2', '2. Sample/kg'),
      product('product_3', '3. Product'),
      text('sample_kg_3', '3. Sample/kg'),
      product('product_4', '4. Product'),
      text('sample_kg_4', '4. Sample/kg'),
      product('product_5', '5. Product'),
      text('sample_kg_5', '5. Sample/kg'),
      text('requested_by', 'Requested by'),
      sign('customer_sign', 'Customer sign')
    ]
  },

  // 4 ---------------------------------------------------------------------
  {
    name: 'Quality Complaint Form',
    description: 'PRP 12-1-1 Customer Complaint Form. Responsibility: Technical Department. Effective 26/03/2021 Version 2.0. ISO 22000:2005 - 7.10',
    category: 'technical',
    fields: [
      select('branch', 'Branch', BRANCHES),
      h('product_details', 'Product Details'),
      text('product_code', 'Product code'),
      text('product_name', 'Product name'),
      photo('batch_photo', 'Batch number - photo'),
      text('batch_number', 'Batch number'),
      date('pd_date', 'PD date'),
      date('bb_date', 'BB date'),
      h('customer_details', 'Customer Details'),
      text('customer_contact', 'Customer contact person'),
      date('delivery_date', 'Product delivery date'),
      text('qty_affected', 'Total quantity affected product (per batch)'),
      h('complaint_details', 'Complaint Details'),
      select('type', 'Type', COMPLAINT_TYPES),
      text('description', 'Complaint description'),
      photo('sample_photo', 'Photo/s of sample'),
      h('mixing_baking', 'Mixing and Baking Details'),
      select('mixer_type', 'Mixer type', ['Spiral', 'Paddle', 'N/A']),
      select('oven_type', 'Oven type', ['Deck', 'Rack', 'N/A']),
      select('correct_recipe', 'Was the correct recipe used? (attach recipe used)', YES_NO_NA),
      select('original_packaging', 'Was the product in original packaging?', YES_NO),
      select('stored_correctly', 'Was the product stored correctly?', YES_NO),
      text('significance', 'Any other points of significance?'),
      date('delivery_to_qc', 'Date sample will be delivered to QC'),
      text('comments', 'Additional comments / feedback')
    ]
  },

  // 5 ---------------------------------------------------------------------
  {
    name: 'Food Safety Complaint Form',
    description: 'PRP 12-1-1 Customer Complaint Form. Responsibility: Technical Department. Effective 26/03/2021 Version 2.0. ISO 22000:2005 - 7.10',
    category: 'technical',
    fields: [
      select('branch', 'Branch', BRANCHES),
      h('product_details', 'Product Details'),
      text('product_code', 'Product code'),
      text('product_name', 'Product name'),
      photo('batch_photo', 'Batch number - photo'),
      text('batch_number', 'Batch number'),
      date('pd_date', 'PD date'),
      date('bb_date', 'BB date'),
      h('customer_details', 'Customer Details'),
      text('customer_contact', 'Customer contact person'),
      date('delivery_date', 'Product delivery date'),
      text('qty_affected', 'Total quantity affected product (per batch)'),
      h('complaint_details', 'Complaint Details'),
      select('type', 'Type', COMPLAINT_TYPES),
      text('description', 'Complaint description'),
      photo('sample_photo', 'Photo/s of sample'),
      select('correct_recipe', 'Was the correct recipe used? (attached recipe used)', YES_NO_NA),
      select('original_packaging', 'Was the product in original packaging?', YES_NO),
      select('stored_correctly', 'Was the product stored correctly?', YES_NO),
      text('significance', 'Any other points of significance?'),
      date('delivery_to_fs', 'Date sample will be delivered to FS'),
      text('comments', 'Additional comments / feedback')
    ]
  },

  // 8 ---------------------------------------------------------------------
  {
    name: 'Collection Advice Note',
    description: 'Advise a collection / uplift of product from the customer.',
    fields: [
      text('requested_by', 'Requested by'),
      text('customer_details', 'Customer details'),
      text('goods_on_invoice', 'Goods supplied on invoice'),
      text('reason', 'Reason'),
      text('product_1_code', 'Product 1 code'),
      text('product_1_description', 'Product 1 description'),
      text('qty_product_1', 'QTY of product 1'),
      text('product_1_pack_weight', 'Product 1 pack weight'),
      text('product_2_code', 'Product 2 code'),
      text('product_2_description', 'Product 2 description'),
      text('qty_product_2', 'QTY of product 2'),
      text('product_2_pack_weight', 'Product 2 pack weight'),
      sign('representative_signature', 'Representative signature')
    ]
  },

  // 9 ---------------------------------------------------------------------
  {
    name: 'Technical Assistance Request Sheet',
    description: 'Request technical assistance / a product demonstration for a customer, with product/sample line items, training attendance and customer sign-off.',
    category: 'technical',
    fields: [
      text('demo_requested_by', 'Demo requested by'),
      date('date_requested', 'Date requested'),
      text('customer', 'Customer'),
      text('account_number', 'Account Number'),
      text('contact_person', 'Contact Person'),
      text('demonstrator', 'Demonstrator'),
      text('address', 'Address'),
      text('bus_tel', 'Bus Tel'),
      text('cell_no', 'Cell No'),
      h('products_section', 'Products To Be Demonstrated: List Samples and End Products'),
      h('basic_bread_heading', 'Basic Bread & Rolls'),
      product('basic_bread_product_1', '1. Product'), select('basic_bread_samples_1', '1. Take samples', YES_NO),
      product('basic_bread_product_2', '2. Product'), select('basic_bread_samples_2', '2. Take samples', YES_NO),
      product('basic_bread_product_3', '3. Product'), select('basic_bread_samples_3', '3. Take samples', YES_NO),
      product('basic_bread_product_4', '4. Product'), select('basic_bread_samples_4', '4. Take samples', YES_NO),
      product('basic_bread_product_5', '5. Product'), select('basic_bread_samples_5', '5. Take samples', YES_NO),
      h('confectionary_heading', 'Confectionary'),
      product('confectionary_product_1', '1. Product'), select('confectionary_samples_1', '1. Take samples', YES_NO),
      product('confectionary_product_2', '2. Product'), select('confectionary_samples_2', '2. Take samples', YES_NO),
      product('confectionary_product_3', '3. Product'), select('confectionary_samples_3', '3. Take samples', YES_NO),
      product('confectionary_product_4', '4. Product'), select('confectionary_samples_4', '4. Take samples', YES_NO),
      product('confectionary_product_5', '5. Product'), select('confectionary_samples_5', '5. Take samples', YES_NO),
      text('additional_comments', 'Additional comments'),
      h('speciality_bread_heading', 'Speciality Bread Range'),
      product('speciality_bread_product_1', '1. Product'), select('speciality_bread_samples_1', '1. Take samples', YES_NO),
      product('speciality_bread_product_2', '2. Product'), select('speciality_bread_samples_2', '2. Take samples', YES_NO),
      product('speciality_bread_product_3', '3. Product'), select('speciality_bread_samples_3', '3. Take samples', YES_NO),
      product('speciality_bread_product_4', '4. Product'), select('speciality_bread_samples_4', '4. Take samples', YES_NO),
      product('speciality_bread_product_5', '5. Product'), select('speciality_bread_samples_5', '5. Take samples', YES_NO),
      h('decorating_heading', 'Decorating'),
      product('decorating_product_1', '1. Product'), select('decorating_samples_1', '1. Take samples', YES_NO),
      product('decorating_product_2', '2. Product'), select('decorating_samples_2', '2. Take samples', YES_NO),
      product('decorating_product_3', '3. Product'), select('decorating_samples_3', '3. Take samples', YES_NO),
      product('decorating_product_4', '4. Product'), select('decorating_samples_4', '4. Take samples', YES_NO),
      product('decorating_product_5', '5. Product'), select('decorating_samples_5', '5. Take samples', YES_NO),
      h('training_section', 'Training done from / to'),
      text('training_from', 'Training done from (am)'),
      text('training_to', 'Training done to (pm)'),
      text('demonstrators_name', "Demonstrator's name"),
      h('present_at_training', 'Present at training'),
      text('present_1', '1. Present at training'), text('present_id_1', '1. I.D. Number'), text('present_group_1', '1. Designated Group'), sign('present_signature_1', '1. Signature'),
      text('present_2', '2. Present at training'), text('present_id_2', '2. I.D. Number'), text('present_group_2', '2. Designated Group'), sign('present_signature_2', '2. Signature'),
      text('present_3', '3. Present at training'), text('present_id_3', '3. I.D. Number'), text('present_group_3', '3. Designated Group'), sign('present_signature_3', '3. Signature'),
      text('present_4', '4. Present at training'), text('present_id_4', '4. I.D. Number'), text('present_group_4', '4. Designated Group'), sign('present_signature_4', '4. Signature'),
      text('present_5', '5. Present at training'), text('present_id_5', '5. I.D. Number'), text('present_group_5', '5. Designated Group'), sign('present_signature_5', '5. Signature'),
      text('demonstrator_confirm', 'Demonstrator'),
      sign('demonstrator_signature', 'Signature'),
      h('customer_section', 'To be completed by customer'),
      text('arrival_time', 'Arrival Time'),
      text('departure_time', 'Departure Time'),
      select('demo_on_time', 'Was the demo done on time?', YES_NO),
      select('demo_good', 'Was the product Demonstration Good?', YES_NO),
      select('interested_other', 'Are you interested in Other Products?', YES_NO),
      select('placed_order', 'Did you Place an Order?', YES_NO),
      text('customer_name', 'Customer Name'),
      sign('customer_signature', 'Customer Signature')
    ]
  }
];

// Version-gated reseed: on first boot at a new SEED_VERSION, remove every
// existing template (and their submissions, so the FK stays valid) and install
// the set above. Runs once per version, so admin edits made afterwards survive
// restarts until the version is bumped again.
export async function ensureDefaultForms() {
  if (await getSetting('forms_seed_version') === SEED_VERSION) return;

  await dbx.transaction(async (tx) => {
    await tx.prepare('DELETE FROM form_submissions').run();
    await tx.prepare('DELETE FROM form_templates').run();
    // Restart ids at 1, as a fresh database would.
    if (tx.dialect === 'mssql') {
      await tx.exec("DBCC CHECKIDENT ('form_templates', RESEED, 0); DBCC CHECKIDENT ('form_submissions', RESEED, 0)");
    } else {
      await tx.prepare("DELETE FROM sqlite_sequence WHERE name IN ('form_templates', 'form_submissions')").run();
    }
    const insert = tx.prepare(
      'INSERT INTO form_templates (name, description, fields, category, active) VALUES (?, ?, ?, ?, 1)'
    );
    for (const f of DEFAULT_FORMS) {
      await insert.run(f.name, f.description || null, JSON.stringify(f.fields), f.category === 'technical' ? 'technical' : 'general');
    }
    await setSetting('forms_seed_version', SEED_VERSION, tx);
  });
  console.log(`[forms] reseeded ${DEFAULT_FORMS.length} field form(s) (version ${SEED_VERSION})`);
}
