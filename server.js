const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { scheduleJob, scheduledJobs } = require('node-schedule');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Timezone configuration (BD time = UTC+6)
const TIMEZONE_OFFSET = 6; // hours ahead of UTC
const TIMEZONE = 'Asia/Dhaka';

// StreakUp Supabase configuration (original app)
const STREAKUP_SUPABASE_URL = process.env.STREAKUP_SUPABASE_URL || 'https://nilltdjafpxgqgetbhzs.supabase.co';
const STREAKUP_SUPABASE_ANON_KEY = process.env.STREAKUP_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pbGx0ZGphZnB4Z3FnZXRiaHpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5OTY4MTIsImV4cCI6MjEwMDU3MjgxMn0.BNe9WOeyt4qhk_xaiwekgOzy4bU8rSKX_dJK-WRBLfo';

// Bot Manager Supabase configuration
const BOT_MANAGER_SUPABASE_URL = process.env.BOT_MANAGER_SUPABASE_URL || 'https://nalpunvxaskrlkpilzcn.supabase.co';
const BOT_MANAGER_SUPABASE_ANON_KEY = process.env.BOT_MANAGER_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5hbHB1bnZ4YXNrcmxrcGlsemNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0NzUyMzMsImV4cCI6MjEwMTA1MTIzM30.WxuUFArPmukenk8mYctya3PcGr87DFn7uPFRIdqkG8I';

const streakupSupabase = createClient(STREAKUP_SUPABASE_URL, STREAKUP_SUPABASE_ANON_KEY);
const botManagerSupabase = createClient(BOT_MANAGER_SUPABASE_URL, BOT_MANAGER_SUPABASE_ANON_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// Store schedules in memory (in production, use a database)
let activeSchedules = [];
let scheduledTasks = new Map();
let executionHistory = [];

// Fetch pending schedules from simplified database
async function fetchPendingSchedules() {
    try {
        console.log('🔄 Fetching pending schedules from database...');
        
        // Fetch pending schedules with bot details
        const { data: schedules, error: schedulesError } = await botManagerSupabase
            .from('bot_manager_schedules')
            .select('*, bot_manager_bots(*)')
            .eq('status', 'pending')
            .gte('execution_date', new Date().toISOString().split('T')[0])
            .order('execution_date')
            .order('execution_time');
        
        if (schedulesError) throw schedulesError;
        
        console.log(`📋 Found ${schedules?.length || 0} pending schedules`);
        return schedules || [];
    } catch (error) {
        console.error('Error fetching pending schedules:', error);
        return [];
    }
}

// Schedule a single bot execution
async function scheduleExecution(schedule) {
    const bot = schedule.bot_manager_bots;
    if (!bot) {
        console.error(`No bot found for schedule ${schedule.id}`);
        return;
    }

    // Parse execution time (BD time = UTC+6)
    const [hours, minutes] = schedule.execution_time.split(':').map(Number);
    
    // Create execution datetime in BD timezone
    const executionDateBD = new Date(schedule.execution_date);
    executionDateBD.setHours(hours, minutes, 0, 0);
    
    // Convert to UTC (subtract 6 hours)
    const executionDateUTC = new Date(executionDateBD.getTime() - (TIMEZONE_OFFSET * 60 * 60 * 1000));
    
    // Only schedule if in the future
    if (executionDateUTC <= new Date()) {
        console.log(`  ⊘ Skipping ${bot.name} - execution time has passed`);
        return;
    }

    // Schedule the job
    const job = scheduleJob(executionDateUTC, async () => {
        console.log(`🚀 Executing ${bot.name} at ${schedule.execution_time} BD (${executionDateUTC.toISOString()} UTC)`);
        console.log(`   Cycle Date: ${schedule.cycle_date}, Study Minutes: ${schedule.study_minutes}`);
        await executeSchedule(schedule);
    });

    scheduledTasks.set(schedule.id, job);
    console.log(`  ✓ Scheduled ${bot.name} for ${schedule.execution_date} at ${schedule.execution_time} BD`);
}

// Execute a single schedule
async function executeSchedule(schedule) {
    const bot = schedule.bot_manager_bots;
    const executionRecord = {
        botName: bot.name,
        cycleDate: schedule.cycle_date,
        executionTime: schedule.execution_time,
        studyHours: `${Math.floor(schedule.study_minutes / 60)}h ${schedule.study_minutes % 60}m`,
        status: 'pending',
        timestamp: new Date().toISOString(),
        error: null
    };

    try {
        await logStudyHours(bot, schedule.cycle_date, schedule.study_minutes, executionRecord.studyHours);
        executionRecord.status = 'success';
        console.log(`  ✓ ${bot.name}: ${executionRecord.studyHours} at ${schedule.execution_time}`);
        
        // Update status in bot-manager DB
        await botManagerSupabase
            .from('bot_manager_schedules')
            .update({ 
                status: 'done',
                executed_at: new Date().toISOString()
            })
            .eq('id', schedule.id);
            
    } catch (error) {
        executionRecord.status = 'failed';
        executionRecord.error = error.message;
        console.error(`  ✗ ${bot.name} failed:`, error.message);
        
        // Update status to failed
        await botManagerSupabase
            .from('bot_manager_schedules')
            .update({ 
                status: 'failed',
                error_message: error.message,
                executed_at: new Date().toISOString()
            })
            .eq('id', schedule.id);
    }

    // Add to execution history
    executionHistory.unshift(executionRecord);
    if (executionHistory.length > 100) executionHistory.pop();
}

// API endpoint to receive schedule (deprecated - now uses direct DB saves)
app.post('/api/schedule', async (req, res) => {
    res.json({ 
        success: true, 
        message: 'Schedule endpoint deprecated - schedules now saved directly to database'
    });
});

// Get active schedules (from database)
app.get('/api/schedules', async (req, res) => {
    try {
        const { data: schedules } = await botManagerSupabase
            .from('bot_manager_schedules')
            .select('*, bot_manager_bots(*)')
            .eq('status', 'pending')
            .order('execution_date');
        
        res.json({
            activeSchedules: schedules || [],
            total: schedules?.length || 0
        });
    } catch (error) {
        console.error('Error fetching schedules:', error);
        res.status(500).json({ error: 'Failed to fetch schedules' });
    }
});

// Delete a schedule
app.delete('/api/schedules/:id', async (req, res) => {
    const { id } = req.params;
    
    // Cancel task if exists
    if (scheduledTasks.has(id)) {
        const task = scheduledTasks.get(id);
        task.stop();
        scheduledTasks.delete(id);
    }

    // Delete from database
    try {
        const { error } = await botManagerSupabase
            .from('bot_manager_schedules')
            .delete()
            .eq('id', id);

        if (error) throw error;
        
        res.json({ success: true, message: 'Schedule deleted' });
    } catch (error) {
        console.error('Error deleting schedule:', error);
        res.status(500).json({ error: 'Failed to delete schedule' });
    }
});

// Health check with more details
app.get('/health', async (req, res) => {
    const now = new Date();
    const upcomingTasks = [];

    // Count upcoming tasks in next 24 hours
    scheduledTasks.forEach((task, scheduleId) => {
        if (task.nextInvocation()) {
            const nextTime = new Date(task.nextInvocation());
            if (nextTime > now && nextTime < new Date(now.getTime() + 24 * 60 * 60 * 1000)) {
                upcomingTasks.push({
                    scheduleId,
                    nextExecution: nextTime.toISOString()
                });
            }
        }
    });

    // Get pending count from database
    const { data: pendingSchedules } = await botManagerSupabase
        .from('bot_manager_schedules')
        .select('id')
        .eq('status', 'pending');

    res.json({
        status: 'healthy',
        timestamp: now.toISOString(),
        activeSchedules: pendingSchedules?.length || 0,
        scheduledTasks: scheduledTasks.size,
        executionHistoryCount: executionHistory.length,
        upcomingTasksCount: upcomingTasks.length,
        upcomingTasks: upcomingTasks.slice(0, 10)
    });
});

// Keep-alive endpoint for cron jobs
app.get('/keep-alive', (req, res) => {
    console.log('🔄 Keep-alive ping received at', new Date().toISOString());
    res.json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        message: 'Server is running and active'
    });
});

// Get execution history
app.get('/api/execution-history', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const history = executionHistory.slice(-limit).reverse();
    res.json({
        total: executionHistory.length,
        history: history
    });
});

// API endpoint to fetch pending executions from bot-manager DB (deprecated)
app.get('/api/bot-manager/pending-executions', async (req, res) => {
    try {
        const { data: schedules, error } = await botManagerSupabase
            .from('bot_manager_schedules')
            .select('*, bot_manager_bots(*)')
            .eq('status', 'pending')
            .order('execution_date', { ascending: true });
        
        if (error) throw error;
        
        res.json({
            executions: schedules || [],
            total: schedules?.length || 0
        });
    } catch (error) {
        console.error('Error fetching pending executions:', error);
        res.status(500).json({ error: 'Failed to fetch pending executions' });
    }
});

// API endpoint to update execution status in bot-manager DB (deprecated)
app.post('/api/bot-manager/update-execution', async (req, res) => {
    res.json({ 
        success: true, 
        message: 'Update endpoint deprecated - status updated automatically during execution'
    });
});

// API endpoint to get all schedules from bot-manager DB (deprecated)
app.get('/api/bot-manager/schedules', async (req, res) => {
    try {
        const { data: schedules } = await botManagerSupabase
            .from('bot_manager_schedules')
            .select('*, bot_manager_bots(*)')
            .order('execution_date');
        
        res.json({
            schedules: schedules || [],
            total: schedules?.length || 0
        });
    } catch (error) {
        console.error('Error fetching schedules:', error);
        res.status(500).json({ error: 'Failed to fetch schedules' });
    }
});

// Detailed status dashboard endpoint
app.get('/api/status-dashboard', async (req, res) => {
    try {
        const now = new Date();
        const today = now.toISOString().split('T')[0];

        // Get schedules from database with bot details
        const { data: schedules, error: schedulesError } = await botManagerSupabase
            .from('bot_manager_schedules')
            .select('*')
            .order('execution_date')
            .order('execution_time');

        if (schedulesError) throw schedulesError;

        // Fetch bot details separately
        const botIds = [...new Set(schedules?.map(s => s.bot_id) || [])];
        const { data: bots, error: botsError } = await botManagerSupabase
            .from('bot_manager_bots')
            .select('*')
            .in('id', botIds);

        if (botsError) throw botsError;

        // Create bot lookup map
        const botMap = new Map(bots?.map(b => [b.id, b]) || []);

        const total = schedules?.length || 0;
        const pending = schedules?.filter(s => s.status === 'pending')?.length || 0;
        const completed = schedules?.filter(s => s.status === 'done')?.length || 0;
        const failed = schedules?.filter(s => s.status === 'failed')?.length || 0;

        // Today's executions
        const todayExecutions = schedules?.filter(s => s.execution_date === today) || [];
        const todayCompleted = todayExecutions.filter(s => s.status === 'done').length;
        const todayFailed = todayExecutions.filter(s => s.status === 'failed').length;

        // Calculate upcoming tasks (next 24 hours)
        const upcomingTasks = [];
        const pendingSchedules = schedules?.filter(s => s.status === 'pending') || [];
        
        for (const schedule of pendingSchedules) {
            const [hours, minutes] = schedule.execution_time.split(':').map(Number);
            const executionDateBD = new Date(schedule.execution_date);
            executionDateBD.setHours(hours, minutes, 0, 0);
            const executionDateUTC = new Date(executionDateBD.getTime() - (TIMEZONE_OFFSET * 60 * 60 * 1000));
            
            const timeDiff = executionDateUTC - now;
            const hoursDiff = Math.floor(timeDiff / (1000 * 60 * 60));
            const minutesDiff = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
            
            if (timeDiff > 0 && timeDiff < 24 * 60 * 60 * 1000) {
                let timeString = '';
                if (hoursDiff > 0) {
                    timeString = `${hoursDiff}h ${minutesDiff}m`;
                } else {
                    timeString = `${minutesDiff}m`;
                }
                
                const bot = botMap.get(schedule.bot_id);
                upcomingTasks.push({
                    id: schedule.id,
                    botName: bot?.name || 'Unknown',
                    executionDate: schedule.execution_date,
                    executionTime: schedule.execution_time,
                    cycleDate: schedule.cycle_date,
                    studyMinutes: schedule.study_minutes,
                    timeUntil: timeString,
                    executionAt: executionDateUTC.toISOString()
                });
            }
        }

        // Sort by time until execution
        upcomingTasks.sort((a, b) => new Date(a.executionAt) - new Date(b.executionAt));

        res.json({
            success: true,
            timestamp: now.toISOString(),
            server: {
                status: 'healthy',
                uptime: process.uptime(),
                activeSchedules: pending,
                scheduledTasks: scheduledTasks.size,
                memoryUsage: process.memoryUsage()
            },
            schedules: {
                total: total,
                active: pending,
                completed: completed,
                failed: failed,
                skipped: 0
            },
            executions: {
                total: total,
                pending: pending,
                completed: completed,
                failed: failed,
                skipped: 0,
                upcoming: upcomingTasks.length,
                today: {
                    total: todayExecutions.length,
                    completed: todayCompleted,
                    failed: todayFailed
                }
            },
            recentHistory: executionHistory.slice(0, 10),
            upcomingTasks: upcomingTasks.slice(0, 10)
        });
    } catch (error) {
        console.error('Error fetching status dashboard:', error);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

// Keep-alive endpoint for cron jobs
app.get('/keep-alive', (req, res) => {
    console.log('🔄 Keep-alive ping received at', new Date().toISOString());
    res.json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        message: 'Server is running and active'
    });
});

// Log study hours for a bot
async function logStudyHours(bot, cycleDate, studyMinutes, formatted) {
    const now = new Date().toISOString();

    // Sign in as the bot user
    const { data: signInData, error: signInError } = await streakupSupabase.auth.signInWithPassword({
        email: bot.email,
        password: bot.password
    });

    if (signInError) {
        throw new Error(`Failed to sign in as ${bot.name}: ${signInError.message}`);
    }

    // Use streakup_user_id for StreakUp database operations
    const userId = bot.streakup_user_id || bot.id;

    // Check if log exists for the date
    const { data: existingLog } = await streakupSupabase
        .from('study_logs')
        .select('*')
        .eq('user_id', userId)
        .eq('cycle_date', cycleDate)
        .maybeSingle();

    if (existingLog) {
        // Update existing log
        await streakupSupabase
            .from('study_logs')
            .update({
                study_minutes: studyMinutes,
                study_hours_formatted: formatted,
                logged_at: now
            })
            .eq('id', existingLog.id);
    } else {
        // Create new log
        await streakupSupabase
            .from('study_logs')
            .insert({
                id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                user_id: userId,
                user_name: bot.name,
                cycle_date: cycleDate,
                study_minutes: studyMinutes,
                study_hours_formatted: formatted,
                logged_at: now
            });
    }

    // Sign out
    await streakupSupabase.auth.signOut();
}

// Start server
app.listen(PORT, async () => {
    console.log(`🤖 Bot Scheduler Server running on port ${PORT}`);
    console.log(`📡 Ready to fetch and execute schedules`);

    // Fetch and schedule pending tasks on startup
    const pendingSchedules = await fetchPendingSchedules();
    for (const schedule of pendingSchedules) {
        await scheduleExecution(schedule);
    }
    console.log(`✓ Scheduled ${pendingSchedules.length} pending tasks`);

    // Refresh schedules every 5 minutes to pick up new ones
    setInterval(async () => {
        console.log('🔄 Refreshing schedules...');
        const newSchedules = await fetchPendingSchedules();
        for (const schedule of newSchedules) {
            if (!scheduledTasks.has(schedule.id)) {
                await scheduleExecution(schedule);
            }
        }
        console.log(`✓ Refreshed ${newSchedules.length} schedules`);
    }, 5 * 60 * 1000); // 5 minutes
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    
    // Stop all scheduled tasks
    scheduledTasks.forEach((tasks, scheduleId) => {
        tasks.forEach(task => task.stop());
    });
    scheduledTasks.clear();
    
    process.exit(0);
});
