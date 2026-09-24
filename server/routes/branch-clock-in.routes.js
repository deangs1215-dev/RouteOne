import { Router } from 'express';
import { dbx } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();

// Clock in at the branch
router.post('/branch-clock-in', requireAuth, async (req, res) => {
  const { notes } = req.body;
  try {
    const result = await dbx.prepare(`
      INSERT INTO branch_clock_ins (rep_id, notes)
      VALUES (?, ?)
    `).run(req.user.id, notes || '');

    const clockIn = await dbx.prepare('SELECT * FROM branch_clock_ins WHERE id = ?').get(result.lastInsertRowid);
    res.json(clockIn);
  } catch (e) {
    res.status(500).json({ error: 'Failed to clock in' });
  }
});

// Clock out from the branch
router.post('/branch-clock-in/:id/clock-out', requireAuth, async (req, res) => {
  try {
    const clockIn = await dbx.prepare('SELECT * FROM branch_clock_ins WHERE id = ? AND rep_id = ?').get(req.params.id, req.user.id);
    if (!clockIn) return res.status(404).json({ error: 'Clock in not found' });

    await dbx.prepare(`
      UPDATE branch_clock_ins SET clock_out_at = datetime('now') WHERE id = ?
    `).run(req.params.id);

    const updated = await dbx.prepare('SELECT * FROM branch_clock_ins WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: 'Failed to clock out' });
  }
});

// Get today's branch clock-ins for the current user
router.get('/branch-clock-in/today', requireAuth, async (req, res) => {
  try {
    const todayISO = new Date().toISOString().split('T')[0];
    const clockIns = await dbx.prepare(`
      SELECT * FROM branch_clock_ins
      WHERE rep_id = ? AND DATE(clock_in_at) = ?
      ORDER BY clock_in_at DESC
    `).all(req.user.id, todayISO);

    res.json(clockIns);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch clock-ins' });
  }
});

// Update branch clock-in notes
router.put('/branch-clock-in/:id', requireAuth, async (req, res) => {
  const { notes } = req.body;
  try {
    const clockIn = await dbx.prepare('SELECT * FROM branch_clock_ins WHERE id = ? AND rep_id = ?').get(req.params.id, req.user.id);
    if (!clockIn) return res.status(404).json({ error: 'Clock in not found' });

    await dbx.prepare(`
      UPDATE branch_clock_ins SET notes = ? WHERE id = ?
    `).run(notes || '', req.params.id);

    const updated = await dbx.prepare('SELECT * FROM branch_clock_ins WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: 'Failed to update clock-in' });
  }
});

export default router;
