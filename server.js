import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import bcryptjs from 'bcryptjs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Multer for selfie uploads
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ============================================
// AUTHENTICATION ROUTES
// ============================================

// Register User
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    // CHECK: Only one CEO account allowed
    if (role === 'ceo') {
      const { data: existingCEO, error: checkError } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('role', 'ceo')
        .single();

      if (existingCEO) {
        return res.status(400).json({ 
          error: 'A CEO account already exists. Only one CEO account is allowed per organization.' 
        });
      }
    }

    // Create user in Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    // Create user profile in database using ADMIN client (bypass RLS)
    const { data, error } = await supabaseAdmin
      .from('users')
      .insert([
        {
          id: authData.user.id,
          email,
          name,
          role: role || 'employee',
        },
      ])
      .select();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ user: data[0], message: 'User registered successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login User
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(401).json({ error: error.message });
    }

    // Get user profile
    const { data: userProfile } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single();

    res.json({
      user: userProfile,
      session: data.session,
      token: data.session.access_token,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// TASK ROUTES
// ============================================

// Create Task
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, description, assigned_by, expected_completion_date } = req.body;
    const userId = req.headers['x-user-id'];

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert([
        {
          title,
          description,
          created_by: userId,
          assigned_by,
          expected_completion_date,
        },
      ])
      .select();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ task: data[0], message: 'Task created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get All Tasks (with filters)
app.get('/api/tasks', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { status, employee_id } = req.query;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let query = supabase
      .from('tasks')
      .select(`
        *,
        created_by_user:users!created_by(name, email),
        assigned_by_user:users!assigned_by(name, email),
        task_updates(*),
        selfies(*)
      `);

    // CEO sees all tasks, employees see their own
    const { data: userRole } = await supabase
      .from('users')
      .select('role')
      .eq('id', userId)
      .single();

    if (userRole?.role !== 'ceo') {
      query = query.or(`created_by.eq.${userId},assigned_by.eq.${userId}`);
    }

    if (status) {
      query = query.eq('status', status);
    }

    if (employee_id) {
      query = query.eq('created_by', employee_id);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ tasks: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Single Task
app.get('/api/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('tasks')
      .select(`
        *,
        created_by_user:users!created_by(name, email),
        assigned_by_user:users!assigned_by(name, email),
        task_updates(*),
        selfies(*)
      `)
      .eq('id', id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json({ task: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Task Progress
app.put('/api/tasks/:id/progress', async (req, res) => {
  try {
    const { id } = req.params;
    const { completion_percentage, notes } = req.body;
    const userId = req.headers['x-user-id'];

    // Add progress update
    const { data: updateData, error: updateError } = await supabase
      .from('task_updates')
      .insert([
        {
          task_id: id,
          completion_percentage,
          notes,
        },
      ])
      .select();

    if (updateError) {
      return res.status(400).json({ error: updateError.message });
    }

    res.json({ update: updateData[0], message: 'Task progress updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark Task as Complete
app.put('/api/tasks/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.headers['x-user-id'];

    const { data, error } = await supabase
      .from('tasks')
      .update({
        status: 'pending_verification',
        actual_completion_date: new Date(),
      })
      .eq('id', id)
      .eq('created_by', userId)
      .select();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ task: data[0], message: 'Task marked for verification' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// VERIFICATION & POINTS ROUTES
// ============================================

// Verify Task & Award Points
app.put('/api/tasks/:id/verify', async (req, res) => {
  try {
    const { id } = req.params;
    const { base_points, approved } = req.body;
    const verifierId = req.headers['x-user-id'];

    if (!approved) {
      // Reject task
      const { data, error } = await supabase
        .from('tasks')
        .update({ status: 'rejected' })
        .eq('id', id)
        .select();

      if (error) return res.status(400).json({ error: error.message });
      return res.json({ task: data[0], message: 'Task rejected' });
    }

    // Approve task
    // Get task details
    const { data: taskData } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', id)
      .single();

    // Get selfie bonus if exists
    const { data: selfieData } = await supabase
      .from('selfies')
      .select('points_awarded')
      .eq('task_id', id)
      .single();

    const selfieBonus = selfieData?.points_awarded || 0;
    const totalPoints = base_points + selfieBonus;

    // Update task
    const { data: updatedTask, error: taskError } = await supabase
      .from('tasks')
      .update({
        status: 'completed',
        base_points_awarded: base_points,
      })
      .eq('id', id)
      .select();

    if (taskError) return res.status(400).json({ error: taskError.message });

    // Record points
    const { data: pointsData, error: pointsError } = await supabase
      .from('points_history')
      .insert([
        {
          employee_id: taskData.created_by,
          task_id: id,
          base_points,
          selfie_bonus: selfieBonus,
          total_points: totalPoints,
        },
      ])
      .select();

    if (pointsError) return res.status(400).json({ error: pointsError.message });

    res.json({
      task: updatedTask[0],
      points: pointsData[0],
      message: 'Task approved and points awarded',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SELFIE ROUTES
// ============================================

// Upload Selfie
app.post('/api/selfies/upload', upload.single('selfie'), async (req, res) => {
  try {
    const { task_id } = req.body;
    const userId = req.headers['x-user-id'];

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Generate random selfie bonus (1.5 to 2)
    const selfieBonus = parseFloat((Math.random() * 0.5 + 1.5).toFixed(1));

    // Upload to Supabase Storage
    const fileName = `${userId}/${Date.now()}.jpg`;
    const { error: uploadError } = await supabase.storage
      .from('selfies')
      .upload(fileName, req.file.buffer, {
        contentType: 'image/jpeg',
      });

    if (uploadError) {
      return res.status(400).json({ error: uploadError.message });
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('selfies')
      .getPublicUrl(fileName);

    // Delete old selfie if exists
    const { data: oldSelfie } = await supabase
      .from('selfies')
      .select('selfie_url')
      .eq('employee_id', userId)
      .single();

    if (oldSelfie?.selfie_url) {
      // Extract file path and delete
      const oldPath = oldSelfie.selfie_url.split('/').pop();
      await supabase.storage.from('selfies').remove([`${userId}/${oldPath}`]);
    }

    // Save selfie record (upsert - replace if exists)
    const { data, error } = await supabase
      .from('selfies')
      .upsert(
        {
          employee_id: userId,
          task_id,
          selfie_url: urlData.publicUrl,
          points_awarded: selfieBonus,
        },
        { onConflict: 'employee_id' }
      )
      .select();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Update task selfie flag
    await supabase
      .from('tasks')
      .update({ selfie_uploaded: true })
      .eq('id', task_id);

    res.json({
      selfie: data[0],
      message: `Selfie uploaded! 🎉 Bonus points: +${selfieBonus}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// POINTS & ANALYTICS ROUTES
// ============================================

// Get Employee Points (This Month & All-Time)
app.get('/api/points/:employee_id', async (req, res) => {
  try {
    const { employee_id } = req.params;

    // All-time points
    const { data: allTimeData } = await supabase
      .from('points_history')
      .select('total_points')
      .eq('employee_id', employee_id);

    const allTimePoints = allTimeData?.reduce((sum, p) => sum + p.total_points, 0) || 0;

    // This month points
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const { data: monthData } = await supabase
      .from('points_history')
      .select('total_points')
      .eq('employee_id', employee_id)
      .gte('awarded_date', monthStart.toISOString());

    const thisMonthPoints = monthData?.reduce((sum, p) => sum + p.total_points, 0) || 0;

    res.json({
      all_time: allTimePoints,
      this_month: thisMonthPoints,
      current_month: now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Leaderboard (This Month)
app.get('/api/leaderboard', async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const { data, error } = await supabase
      .from('points_history')
      .select(`
        total_points,
        awarded_date,
        employee_id,
        users!employee_id(name, email)
      `)
      .gte('awarded_date', monthStart.toISOString());

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Group by employee and sum points
    const leaderboard = {};
    data.forEach((entry) => {
      const empId = entry.employee_id;
      if (!leaderboard[empId]) {
        leaderboard[empId] = {
          name: entry.users.name,
          email: entry.users.email,
          points: 0,
        };
      }
      leaderboard[empId].points += entry.total_points;
    });

    // Sort and format
    const sorted = Object.entries(leaderboard)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);

    res.json({ leaderboard: sorted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get All Users (for dropdown)
app.get('/api/users', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, email, role')
      .order('name');

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ users: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SERVER START
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

export default app;