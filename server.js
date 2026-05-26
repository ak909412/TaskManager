// ============================================
// TASK MANAGER - FRESH BACKEND SERVER
// Clean, tested, production-ready
// ============================================

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import multer from 'multer';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));

// ============================================
// SUPABASE SETUP
// ============================================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ============================================
// MULTER SETUP (File uploads)
// ============================================

const storage = multer.memoryStorage();
const upload = multer({ 
  storage, 
  limits: { fileSize: 10 * 1024 * 1024 } 
});

// ============================================
// SPECIAL USERS - CAN ASSIGN TASKS
// ============================================

const SPECIAL_ASSIGNERS = [
  'saloniphotography911@gmail.com',
  'ak909412@gmail.com',
  'vikaskumar8800.vk@gmail.com',
];

// ============================================
// AUTHENTICATION ROUTES
// ============================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    // Only one CEO allowed
    // if (role === 'ceo') {
    //   const { data: existing } = await supabaseAdmin
    //     .from('users')
    //     .select('id')
    //     .eq('role', 'ceo')
    //     .single();

    //   if (existing) {
    //     return res.status(400).json({ error: 'CEO already exists' });
    //   }
    // }

    // Allow up to 5 CEOs
if (role === 'ceo') {
  const { data: existing, error } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('role', 'ceo');

  if (existing && existing.length >= 3) {
    return res.status(400).json({ error: 'Maximum 5 CEOs allowed' });
  }
}

    // Create auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError) throw authError;

    // Create user profile
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .insert([{ id: authData.user.id, email, name, role: role || 'employee' }])
      .select();

    if (userError) throw userError;

    res.json({ user: user[0], message: 'Registered successfully' });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;

    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single();

    res.json({
      user,
      token: data.session.access_token,
    });
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: 'Login failed' });
  }
});

// ============================================
// TASK ROUTES
// ============================================

app.post('/api/tasks', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { title, description, assigned_to, assigned_by, priority, category } = req.body;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!title || !description) return res.status(400).json({ error: 'Title and description required' });

    // Check assign permission
    if (assigned_to) {
      const { data: user } = await supabase
        .from('users')
        .select('role, email')
        .eq('id', userId)
        .single();

      const canAssign = user?.role === 'ceo' || 
                       user?.role === 'admin' || 
                       SPECIAL_ASSIGNERS.includes(user?.email);

      if (!canAssign) {
        return res.status(403).json({ error: 'Cannot assign tasks' });
      }
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert([{
        title,
        description,
        created_by: userId,
        assigned_to: assigned_to || null,
        assigned_by: assigned_by || userId,
        priority: priority || 'medium',
        category: category || null,
        status: 'not_started',
      }])
      .select();

    if (error) throw error;

    res.json({ task: data[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/tasks', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { data: user } = await supabase
      .from('users')
      .select('role')
      .eq('id', userId)
      .single();

    let query = supabase.from('tasks').select('*');

    // Only show relevant tasks
    if (user?.role !== 'admin' && user?.role !== 'ceo') {
      query = query.or(`created_by.eq.${userId},assigned_to.eq.${userId},assigned_by.eq.${userId}`);
    }

    const { data: tasks, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;

    // Fetch user details for each task
    const tasksWithUsers = await Promise.all((tasks || []).map(async (task) => {
      let createdByUser = null;
      let assignedByUser = null;

      if (task.created_by) {
        const { data: u } = await supabase
          .from('users')
          .select('id, name, email')
          .eq('id', task.created_by)
          .single();
        createdByUser = u;
      }

      if (task.assigned_by) {
        const { data: u } = await supabase
          .from('users')
          .select('id, name, email')
          .eq('id', task.assigned_by)
          .single();
        assignedByUser = u;
      }

      return {
        ...task,
        created_by_user: createdByUser,
        assigned_by_user: assignedByUser,
      };
    }));

    res.json({ tasks: tasksWithUsers || [] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: task, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;

    // Get user details
    let createdByUser = null;
    let assignedByUser = null;

    if (task.created_by) {
      const { data: user } = await supabase
        .from('users')
        .select('id, name, email')
        .eq('id', task.created_by)
        .single();
      createdByUser = user;
    }

    if (task.assigned_by) {
      const { data: user } = await supabase
        .from('users')
        .select('id, name, email')
        .eq('id', task.assigned_by)
        .single();
      assignedByUser = user;
    }

    // Get task updates
    const { data: taskUpdates } = await supabase
      .from('task_updates')
      .select('*')
      .eq('task_id', id)
      .order('created_at', { ascending: false });

    res.json({ 
      task: {
        ...task,
        created_by_user: createdByUser,
        assigned_by_user: assignedByUser,
        task_updates: taskUpdates || [],
      }
    });
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: 'Task not found' });
  }
});

app.put('/api/tasks/:id/progress', async (req, res) => {
  try {
    const { id } = req.params;
    const { completion_percentage, notes } = req.body;

    // Auto-update task status to in_progress
    await supabase
      .from('tasks')
      .update({ status: 'in_progress' })
      .eq('id', id);

    const { data, error } = await supabase
      .from('task_updates')
      .insert([{
        task_id: id,
        completion_percentage,
        notes,
      }])
      .select();

    if (error) throw error;

    res.json({ update: data[0], message: 'Progress updated - task now in progress' });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/tasks/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.headers['x-user-id'];

    // Allow either creator OR assigned_to person to mark complete
    const { data, error } = await supabase
      .from('tasks')
      .update({ status: 'pending_verification' })
      .eq('id', id)
      .or(`created_by.eq.${userId},assigned_to.eq.${userId}`)
      .select();

    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(403).json({ error: 'Only task creator or assignee can mark complete' });
    }

    res.json({ task: data[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/tasks/:id/verify', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.headers['x-user-id'];
    const { approved, base_points } = req.body;

    const { data: task } = await supabase
      .from('tasks')
      .select('assigned_by, created_by, assigned_to')
      .eq('id', id)
      .single();

    if (!task) return res.status(404).json({ error: 'Task not found' });

    const { data: user } = await supabase
      .from('users')
      .select('role')
      .eq('id', userId)
      .single();

    // Can verify if: CEO, Admin, or assigned_by person
    const canVerify = user?.role === 'ceo' || 
                     user?.role === 'admin' || 
                     task.assigned_by === userId;

    if (!canVerify) {
      return res.status(403).json({ error: 'Cannot verify this task' });
    }

    if (!approved) {
      const { data, error } = await supabase
        .from('tasks')
        .update({ status: 'rejected' })
        .eq('id', id)
        .select();
      
      if (error) throw error;
      return res.json({ task: data[0], message: 'Task rejected' });
    }

    // Approve and award points
    const { data: updated, error: updateError } = await supabase
      .from('tasks')
      .update({ 
        status: 'completed',
        base_points_awarded: base_points,
      })
      .eq('id', id)
      .select();

    if (updateError) throw updateError;

    // Award points to whoever DID the work:
    // - If assigned_to is set → they did the work
    // - If assigned_to is NULL → creator did the work
    const pointsRecipient = task.assigned_to || task.created_by;

    // Add to points history
    await supabase.from('points_history').insert([{
      employee_id: pointsRecipient,
      task_id: id,
      base_points,
      total_points: base_points,
    }]);

    res.json({ task: updated[0], message: 'Task approved', awardedTo: pointsRecipient });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ============================================
// PROOF OF WORK ROUTES
// ============================================

app.post('/api/proofs/upload', upload.array('proofs', 5), async (req, res) => {
  try {
    const { task_id } = req.body;
    const userId = req.headers['x-user-id'];

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const proofUrls = [];

    for (const file of req.files) {
      const fileName = `${userId}/${task_id}/${Date.now()}-${file.originalname}`;
      
      const { error: uploadError } = await supabase.storage
        .from('proofs')
        .upload(fileName, file.buffer, { contentType: file.mimetype });

      if (uploadError) throw uploadError;

      const { data } = supabase.storage.from('proofs').getPublicUrl(fileName);
      proofUrls.push(data.publicUrl);
    }

    const { data, error } = await supabase
      .from('proofs_of_work')
      .insert(proofUrls.map(url => ({
        task_id,
        employee_id: userId,
        proof_url: url,
        proof_type: 'file',
      })))
      .select();

    if (error) throw error;

    res.json({ proofs: data, message: 'Uploaded successfully' });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/proofs/link', async (req, res) => {
  try {
    const { task_id, proof_link, description } = req.body;
    const userId = req.headers['x-user-id'];

    const { data, error } = await supabase
      .from('proofs_of_work')
      .insert([{
        task_id,
        employee_id: userId,
        proof_url: proof_link,
        proof_type: 'link',
        description,
      }])
      .select();

    if (error) throw error;

    res.json({ proof: data[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/proofs/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;

    const { data, error } = await supabase
      .from('proofs_of_work')
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ proofs: data || [] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ============================================
// UTILITY ROUTES
// ============================================

app.get('/api/users', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, email, role')
      .order('name');

    if (error) throw error;

    res.json({ users: data || [] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/points/:employee_id', async (req, res) => {
  try {
    const { employee_id } = req.params;

    const { data, error } = await supabase
      .from('points_history')
      .select('total_points')
      .eq('employee_id', employee_id);

    if (error) throw error;

    const total = data?.reduce((sum, p) => sum + p.total_points, 0) || 0;

    res.json({ total_points: total });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('points_history')
      .select('employee_id, total_points');

    if (error) throw error;

    const leaderboard = {};
    data?.forEach(item => {
      if (!leaderboard[item.employee_id]) {
        leaderboard[item.employee_id] = 0;
      }
      leaderboard[item.employee_id] += item.total_points;
    });

    const sorted = Object.entries(leaderboard)
      .map(([id, points]) => ({ id, points }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);

    res.json({ leaderboard: sorted });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ============================================
// ADMIN ROUTES
// ============================================

app.get('/api/admin/users', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];

    const { data: admin } = await supabase
      .from('users')
      .select('role')
      .eq('id', userId)
      .single();

    if (admin?.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ users: data || [] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:userId', async (req, res) => {
  try {
    const adminId = req.headers['x-user-id'];
    const { userId } = req.params;

    const { data: admin } = await supabase
      .from('users')
      .select('role')
      .eq('id', adminId)
      .single();

    if (admin?.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await supabaseAdmin.from('users').delete().eq('id', userId);
    await supabaseAdmin.auth.admin.deleteUser(userId);

    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

export default app;
