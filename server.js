// ============================================
// UPDATED server.js WITH EMAIL-BASED PERMISSIONS
// Task assignment only for: CEO + Special Emails
// ============================================

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import multer from 'multer';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb', extended: true }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Supabase Clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ============================================
// SPECIAL USERS - CAN ASSIGN TASKS (EMAIL-BASED)
// ============================================
const TASK_ASSIGNERS = [
  'saloniphotography911@gmail.com',  // Saloni
  'ak909412@gmail.com',               // Anurag
  'vikaskumar8800.vk@gmail.com',      // CEO Vikas
];

// Helper function to check if user can assign tasks
const canAssignTasks = async (userId) => {
  const { data: user } = await supabase
    .from('users')
    .select('role, email')
    .eq('id', userId)
    .single();

  if (!user) return false;

  // CEO and Admin can always assign
  if (user.role === 'ceo' || user.role === 'admin') return true;

  // Only special emails (employees) can assign
  if (user.role === 'employee' && TASK_ASSIGNERS.includes(user.email)) {
    return true;
  }

  return false;
};

// ============================================
// AUTHENTICATION ROUTES
// ============================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    // CHECK: Only one CEO allowed
    if (role === 'ceo') {
      const { data: existingCEO } = await supabaseAdmin
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

    // Create user profile
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

    const { data: userProfile } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single();

    // Check if user can assign tasks
    const canAssign = await canAssignTasks(data.user.id);

    res.json({
      user: { ...userProfile, canAssignTasks: canAssign },
      session: data.session,
      token: data.session.access_token,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// PERMISSIONS CHECK ENDPOINT
// ============================================

app.get('/api/auth/permissions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: user } = await supabase
      .from('users')
      .select('role, email')
      .eq('id', userId)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const canAssign = await canAssignTasks(userId);

    res.json({
      userId,
      role: user.role,
      email: user.email,
      permissions: {
        canCreateTasks: true,
        canAssignTasks: canAssign,
        canVerifyTasks: user.role === 'ceo' || user.role === 'admin',
        canAccessAdmin: user.role === 'admin',
        canUploadProof: true,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ADMIN PANEL ROUTES
// ============================================

app.get('/api/admin/users', async (req, res) => {
  try {
    const adminId = req.headers['x-user-id'];
    
    const { data: adminUser } = await supabase
      .from('users')
      .select('role')
      .eq('id', adminId)
      .single();

    if (adminUser?.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized - Admin only' });
    }

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    res.json({ users: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:userId', async (req, res) => {
  try {
    const adminId = req.headers['x-user-id'];
    const { userId } = req.params;

    const { data: adminUser } = await supabase
      .from('users')
      .select('role')
      .eq('id', adminId)
      .single();

    if (adminUser?.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { error: profileError } = await supabaseAdmin
      .from('users')
      .delete()
      .eq('id', userId);

    if (profileError) return res.status(400).json({ error: profileError.message });

    await supabaseAdmin.auth.admin.deleteUser(userId);

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/users/:userId/points', async (req, res) => {
  try {
    const adminId = req.headers['x-user-id'];
    const { userId } = req.params;
    const { points } = req.body;

    const { data: adminUser } = await supabase
      .from('users')
      .select('role')
      .eq('id', adminId)
      .single();

    if (adminUser?.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { data, error } = await supabase
      .from('points_history')
      .insert([
        {
          employee_id: userId,
          task_id: null,
          base_points: points,
          selfie_bonus: 0,
          total_points: points,
        },
      ])
      .select();

    if (error) return res.status(400).json({ error: error.message });

    res.json({ message: 'Points updated', data: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const adminId = req.headers['x-user-id'];

    const { data: adminUser } = await supabase
      .from('users')
      .select('role')
      .eq('id', adminId)
      .single();

    if (adminUser?.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { data: users } = await supabase.from('users').select('id');
    const { data: tasks } = await supabase.from('tasks').select('id');
    const { data: completed } = await supabase
      .from('tasks')
      .select('id')
      .eq('status', 'completed');

    res.json({
      stats: {
        totalUsers: users?.length || 0,
        totalTasks: tasks?.length || 0,
        completedTasks: completed?.length || 0,
        completionRate: tasks?.length ? ((completed?.length || 0) / tasks.length * 100).toFixed(1) : 0,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// TASK ROUTES WITH PERMISSION CHECKS
// ============================================

app.post('/api/tasks', async (req, res) => {
  try {
    const { title, description, assigned_to, assigned_by, priority, category, expected_completion_date } = req.body;
    const userId = req.headers['x-user-id'];

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // If trying to assign task, check permissions
    if (assigned_to) {
      const canAssign = await canAssignTasks(userId);
      if (!canAssign) {
        return res.status(403).json({ 
          error: 'You do not have permission to assign tasks. Only CEO and special users can assign tasks.' 
        });
      }
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert([
        {
          title,
          description,
          created_by: userId,
          assigned_to: assigned_to || null,
          assigned_by: assigned_by || userId,
          priority: priority || 'medium',
          category: category || null,
          expected_completion_date: expected_completion_date || null,
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

app.get('/api/tasks', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { status } = req.query;

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
        selfies(*),
        proofs_of_work(*)
      `);

    // Get user role
    const { data: userRole } = await supabase
      .from('users')
      .select('role')
      .eq('id', userId)
      .single();

    // Admin sees all
    // CEO sees all
    // Others see: created by them OR assigned to them OR assigned by them
    if (userRole?.role !== 'admin' && userRole?.role !== 'ceo') {
      query = query.or(`created_by.eq.${userId},assigned_to.eq.${userId},assigned_by.eq.${userId}`);
    }

    if (status) {
      query = query.eq('status', status);
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
        selfies(*),
        proofs_of_work(*)
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

app.put('/api/tasks/:id/progress', async (req, res) => {
  try {
    const { id } = req.params;
    const { completion_percentage, notes } = req.body;

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

app.put('/api/tasks/:id/verify', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.headers['x-user-id'];
    const { base_points, approved } = req.body;

    // Get task details
    const { data: task } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', id)
      .single();

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Check if user can verify
    // Can verify if: CEO, Admin, or the person in assigned_by field
    const { data: user } = await supabase
      .from('users')
      .select('role')
      .eq('id', userId)
      .single();

    const canVerify = 
      user?.role === 'ceo' || 
      user?.role === 'admin' || 
      task.assigned_by === userId;

    if (!canVerify) {
      return res.status(403).json({ 
        error: 'Only the person who assigned this task (or CEO/Admin) can verify it' 
      });
    }

    if (!approved) {
      const { data, error } = await supabase
        .from('tasks')
        .update({ status: 'rejected' })
        .eq('id', id)
        .select();

      if (error) return res.status(400).json({ error: error.message });
      return res.json({ task: data[0], message: 'Task rejected' });
    }

    const { data: taskData } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', id)
      .single();

    const { data: selfieData } = await supabase
      .from('selfies')
      .select('points_awarded')
      .eq('task_id', id)
      .single();

    const selfieBonus = selfieData?.points_awarded || 0;
    const totalPoints = base_points + selfieBonus;

    const { data: updatedTask, error: taskError } = await supabase
      .from('tasks')
      .update({
        status: 'completed',
        base_points_awarded: base_points,
      })
      .eq('id', id)
      .select();

    if (taskError) return res.status(400).json({ error: taskError.message });

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
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
        });

      if (uploadError) {
        return res.status(400).json({ error: uploadError.message });
      }

      const { data: urlData } = supabase.storage
        .from('proofs')
        .getPublicUrl(fileName);

      proofUrls.push(urlData.publicUrl);
    }

    const { data, error } = await supabase
      .from('proofs_of_work')
      .insert(
        proofUrls.map(url => ({
          task_id,
          employee_id: userId,
          proof_url: url,
          proof_type: 'file',
        }))
      )
      .select();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({
      proofs: data,
      message: 'Proofs uploaded successfully',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/proofs/link', async (req, res) => {
  try {
    const { task_id, proof_link, description } = req.body;
    const userId = req.headers['x-user-id'];

    const { data, error } = await supabase
      .from('proofs_of_work')
      .insert([
        {
          task_id,
          employee_id: userId,
          proof_url: proof_link,
          proof_type: 'link',
          description,
        },
      ])
      .select();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({
      proof: data[0],
      message: 'Proof link added successfully',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ proofs: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SELFIE ROUTES
// ============================================

app.post('/api/selfies/upload', upload.single('selfie'), async (req, res) => {
  try {
    const { task_id } = req.body;
    const userId = req.headers['x-user-id'];

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const selfieBonus = parseFloat((Math.random() * 0.5 + 1.5).toFixed(1));

    const fileName = `${userId}/${Date.now()}.jpg`;
    const { error: uploadError } = await supabase.storage
      .from('selfies')
      .upload(fileName, req.file.buffer, {
        contentType: 'image/jpeg',
      });

    if (uploadError) {
      return res.status(400).json({ error: uploadError.message });
    }

    const { data: urlData } = supabase.storage
      .from('selfies')
      .getPublicUrl(fileName);

    const { data: oldSelfie } = await supabase
      .from('selfies')
      .select('selfie_url')
      .eq('employee_id', userId)
      .single();

    if (oldSelfie?.selfie_url) {
      const oldPath = oldSelfie.selfie_url.split('/').pop();
      await supabase.storage.from('selfies').remove([`${userId}/${oldPath}`]);
    }

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

app.get('/api/points/:employee_id', async (req, res) => {
  try {
    const { employee_id } = req.params;

    const { data: allTimeData } = await supabase
      .from('points_history')
      .select('total_points')
      .eq('employee_id', employee_id);

    const allTimePoints = allTimeData?.reduce((sum, p) => sum + p.total_points, 0) || 0;

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

    const sorted = Object.entries(leaderboard)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);

    res.json({ leaderboard: sorted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

export default app;
