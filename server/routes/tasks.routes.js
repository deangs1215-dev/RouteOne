// Phase 5: Task management. Reps create and manage their own tasks, assigned by themselves or managers.
// Tasks are linked to customers and appear in activity timeline and daily call cycle.
import { Router } from 'express';
import { dbx, getTodayISO } from '../db.js';
import { logActivity } from '../dbh.js';
import { requireRole, scopeForUser, userCanAccessCustomerAsync } from '../auth.js';

const router = Router();

const TASK_TYPES = ['Call Customer', 'Visit Customer', 'Follow Up Quote', 'Follow Up Order', 'Resolve Query', 'Collect Payment', 'Deliver Sample', 'Other'];

// --- Create task ---
// Body: { customer_id, assigned_to, task_type, follow_up_date, notes? }
// Auto-populated: created_by (from req.user), branch (from user's branch if available), created_at
router.post('/tasks', async (req, res) => {
  const b = req.body || {};
  const scope = scopeForUser(req.user);

  // Reps can only create tasks assigned to themselves; managers can assign to anyone.
  const assignedTo = Number(b.assigned_to) || req.user.id;
  if (scope.isRep && assignedTo !== req.user.id) {
    return res.status(403).json({ error: 'Reps can only assign tasks to themselves' });
  }

  if (!b.follow_up_date || !/^\d{4}-\d{2}-\d{2}$/.test(b.follow_up_date)) {
    return res.status(400).json({ error: 'follow_up_date (YYYY-MM-DD) is required' });
  }
  if (!TASK_TYPES.includes(b.task_type)) {
    return res.status(400).json({ error: `Invalid task_type. Must be one of: ${TASK_TYPES.join(', ')}` });
  }

  const customer = b.customer_id ? await dbx.prepare('SELECT id FROM customers WHERE id = ?').get(b.customer_id) : null;
  if (b.customer_id && !customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  if (b.customer_id && !await userCanAccessCustomerAsync(req.user, b.customer_id)) {
    return res.status(403).json({ error: 'Not your customer' });
  }

  const assignee = await dbx.prepare('SELECT id FROM users WHERE id = ?').get(assignedTo);
  if (!assignee) {
    return res.status(404).json({ error: 'Assigned user not found' });
  }

  const info = await dbx.prepare(`
    INSERT INTO tasks (customer_id, assigned_to, created_by, task_type, follow_up_date, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, 'open')
  `).run(
    b.customer_id || null,
    assignedTo,
    req.user.id,
    b.task_type,
    b.follow_up_date,
    b.notes || null
  );

  await logActivity(req.user.id, 'create', 'task', info.lastInsertRowid, {
    customer_id: b.customer_id,
    assigned_to: assignedTo,
    task_type: b.task_type
  });

  res.json({
    id: info.lastInsertRowid,
    customer_id: b.customer_id || null,
    assigned_to: assignedTo,
    created_by: req.user.id,
    task_type: b.task_type,
    follow_up_date: b.follow_up_date,
    notes: b.notes || null,
    status: 'open',
    created_at: new Date().toISOString()
  });
});

// --- Update task (edit, reschedule, mark done/cancelled, reassign) ---
// Body: { follow_up_date?, notes?, status?, assigned_to? } — only send fields you're changing
router.put('/tasks/:id', async (req, res) => {
  const b = req.body || {};
  const task = await dbx.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const scope = scopeForUser(req.user);
  // Reps can only edit their own tasks; managers can edit any.
  if (scope.isRep && task.assigned_to !== req.user.id) {
    return res.status(403).json({ error: 'You can only edit your own tasks' });
  }

  if (b.follow_up_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.follow_up_date)) {
    return res.status(400).json({ error: 'follow_up_date must be YYYY-MM-DD' });
  }
  if (b.status && !['open', 'done', 'cancelled'].includes(b.status)) {
    return res.status(400).json({ error: 'status must be open, done, or cancelled' });
  }

  // Only managers can reassign tasks
  if (b.assigned_to !== undefined && scope.isRep) {
    return res.status(403).json({ error: 'Only managers can reassign tasks' });
  }

  if (b.assigned_to !== undefined) {
    const assignee = await dbx.prepare('SELECT id FROM users WHERE id = ?').get(b.assigned_to);
    if (!assignee) {
      return res.status(404).json({ error: 'Assigned user not found' });
    }
  }

  await dbx.prepare(`
    UPDATE tasks SET
      follow_up_date = COALESCE(?, follow_up_date),
      notes = COALESCE(?, notes),
      status = COALESCE(?, status),
      assigned_to = COALESCE(?, assigned_to),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(b.follow_up_date || null, b.notes || null, b.status || null, b.assigned_to || null, task.id);

  await logActivity(req.user.id, 'update', 'task', task.id, { status: b.status, follow_up_date: b.follow_up_date, assigned_to: b.assigned_to });

  res.json({ ok: true });
});

// --- List all tasks (managers see every rep's; reps see only their own) ---
router.get('/tasks/all', async (req, res) => {
  const scope = scopeForUser(req.user);
  const rows = await dbx.prepare(`
    SELECT t.*, c.name AS customer_name, u.name AS assigned_to_name
    FROM tasks t
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN users u ON u.id = t.assigned_to
    ${scope.isRep ? 'WHERE t.assigned_to = ?' : ''}
    ORDER BY t.follow_up_date ASC, t.created_at DESC
  `).all(...(scope.isRep ? [req.user.id] : []));
  res.json(rows);
});

// --- List tasks with filter ---
// Query: filter=today|overdue|upcoming|done
// Returns tasks assigned to the current rep (or all if manager + no filter applied intelligently)
router.get('/tasks', async (req, res) => {
  const scope = scopeForUser(req.user);
  const filter = req.query.filter || 'upcoming'; // default to upcoming
  const today = getTodayISO();

  let where = '';
  const params = [];

  if (scope.isRep) {
    where = 't.assigned_to = ?';
    params.push(req.user.id);
  }

  // Filter by date and status
  let dateCondition = '';
  if (filter === 'today') {
    dateCondition = `t.follow_up_date = '${today}' AND t.status = 'open'`;
  } else if (filter === 'overdue') {
    dateCondition = `t.follow_up_date < '${today}' AND t.status = 'open'`;
  } else if (filter === 'upcoming') {
    dateCondition = `t.follow_up_date >= '${today}' AND t.status = 'open'`;
  } else if (filter === 'done') {
    dateCondition = `t.status = 'done'`;
  }

  const whereClause = [where, dateCondition].filter(Boolean).join(' AND ');
  const sql = `
    SELECT t.*, c.name AS customer_name, u.name AS assigned_to_name
    FROM tasks t
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN users u ON u.id = t.assigned_to
    ${whereClause ? 'WHERE ' + whereClause : ''}
    ORDER BY t.follow_up_date ASC, t.created_at DESC
  `;

  const rows = await dbx.prepare(sql).all(...params);
  res.json(rows);
});

// --- Tasks for a customer (for activity timeline) ---
router.get('/customers/:customerId/tasks', async (req, res) => {
  if (scopeForUser(req.user).isRep) {
    const customer = await dbx.prepare('SELECT rep_id FROM customers WHERE id = ?').get(req.params.customerId);
    if (!customer || customer.rep_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your customer' });
    }
  }
  const rows = await dbx.prepare(`
    SELECT t.*, u.name AS assigned_to_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.customer_id = ?
    ORDER BY t.follow_up_date DESC, t.created_at DESC
    LIMIT 10
  `).all(req.params.customerId);
  res.json(rows);
});

// --- Augment /my-day with task summary ---
// This endpoint already exists; the caller can fetch tasks separately via GET /tasks?filter=today
// But we can optionally return task counts in the /my-day response if needed.
// For now, tasks are a separate query, keeping /my-day lightweight.

export default router;
