const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase configuration
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nilltdjafpxgqgetbhzs.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pbGx0ZGphZnB4Z3FnZXRiaHpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5OTY4MTIsImV4cCI6MjEwMDU3MjgxMn0.BNe9WOeyt4qhk_xaiwekgOzy4bU8rSKX_dJK-WRBLfo';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// Store schedules in memory (in production, use a database)
let activeSchedules = [];
let scheduledTasks = new Map();

// API endpoint to receive schedule
app.post('/api/schedule', async (req, res) => {
    try {
        const schedule = req.body;

        console.log('📅 Received new schedule:', {
            startDate: schedule.startDate,
            endDate: schedule.endDate,
            days: schedule.days,
            bots: schedule.bots.length
        });

        // Validate schedule
        if (!schedule.startDate || !schedule.bots || !Array.isArray(schedule.bots)) {
            return res.status(400).json({ error: 'Invalid schedule format' });
        }

        // Generate unique schedule ID
        const scheduleId = crypto.randomUUID();

        // Store the schedule
        const scheduleWithId = {
            ...schedule,
            id: scheduleId,
            receivedAt: new Date().toISOString(),
            status: 'active'
        };

        activeSchedules.push(scheduleWithId);

        // Setup cron jobs for each day
        await setupScheduleExecution(scheduleWithId);

        res.json({
            success: true,
            scheduleId: scheduleId,
            message: 'Schedule received and tasks scheduled successfully',
            summary: {
                startDate: schedule.startDate,
                endDate: schedule.endDate,
                totalBots: schedule.bots.length,
                totalTasks: schedule.bots.length * schedule.days
            }
        });
    } catch (error) {
        console.error('Error processing schedule:', error);
        res.status(500).json({ error: 'Failed to process schedule' });
    }
});

// Get active schedules
app.get('/api/schedules', (req, res) => {
    res.json({
        activeSchedules: activeSchedules.map(s => ({
            id: s.id,
            startDate: s.startDate,
            endDate: s.endDate,
            bots: s.bots.length,
            status: s.status,
            receivedAt: s.receivedAt
        }))
    });
});

// Delete a schedule
app.delete('/api/schedules/:id', (req, res) => {
    const { id } = req.params;
    
    // Cancel all tasks for this schedule
    if (scheduledTasks.has(id)) {
        const tasks = scheduledTasks.get(id);
        tasks.forEach(task => task.stop());
        scheduledTasks.delete(id);
    }

    // Remove from active schedules
    activeSchedules = activeSchedules.filter(s => s.id !== id);

    res.json({ success: true, message: 'Schedule deleted' });
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        activeSchedules: activeSchedules.length,
        scheduledTasks: scheduledTasks.size
    });
});

// Setup schedule execution with cron jobs
async function setupScheduleExecution(schedule) {
    const tasks = [];
    const startDate = new Date(schedule.startDate);

    console.log(`⏰ Setting up execution for schedule ${schedule.id}`);

    // Create a cron job for each day
    for (let dayIndex = 0; dayIndex < schedule.days; dayIndex++) {
        const currentDate = new Date(startDate);
        currentDate.setDate(currentDate.getDate() + dayIndex);
        const dateStr = currentDate.toISOString().split('T')[0];

        // Schedule execution at 6:00 AM for each day
        const cronExpression = `0 6 ${currentDate.getDate()} ${currentDate.getMonth() + 1} *`;

        const task = cron.schedule(cronExpression, async () => {
            console.log(`🚀 Executing schedule for ${dateStr}`);
            await executeDaySchedule(schedule, dateStr, dayIndex);
        }, {
            scheduled: true,
            timezone: 'UTC'
        });

        tasks.push(task);
        console.log(`  ✓ Scheduled task for ${dateStr} at 06:00 UTC`);
    }

    scheduledTasks.set(schedule.id, tasks);
}

// Execute schedule for a specific day
async function executeDaySchedule(schedule, dateStr, dayIndex) {
    console.log(`📊 Executing ${schedule.bots.length} bot tasks for ${dateStr}`);

    let successCount = 0;
    let failCount = 0;

    for (const botData of schedule.bots) {
        const bot = botData.bot;
        const daySchedule = botData.schedule[dateStr];

        if (!daySchedule || !daySchedule.shouldStudy) {
            console.log(`  ⊘ Skipping ${bot.name} (not scheduled)`);
            continue;
        }

        try {
            await logStudyHours(bot, dateStr, daySchedule.studyMinutes, daySchedule.formatted);
            successCount++;
            console.log(`  ✓ ${bot.name}: ${daySchedule.formatted}`);
        } catch (error) {
            failCount++;
            console.error(`  ✗ ${bot.name} failed:`, error.message);
        }

        // Random delay between bot executions for realism
        await new Promise(resolve => setTimeout(resolve, Math.random() * 5000 + 2000));
    }

    console.log(`📈 Execution complete for ${dateStr}: ${successCount} success, ${failCount} failed`);
}

// Log study hours for a bot
async function logStudyHours(bot, cycleDate, studyMinutes, formatted) {
    const now = new Date().toISOString();

    // Sign in as the bot user
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
        email: bot.email,
        password: bot.password
    });

    if (signInError) {
        throw new Error(`Failed to sign in as ${bot.name}: ${signInError.message}`);
    }

    // Check if log exists for the date
    const { data: existingLog } = await supabase
        .from('study_logs')
        .select('*')
        .eq('user_id', bot.id)
        .eq('cycle_date', cycleDate)
        .maybeSingle();

    if (existingLog) {
        // Update existing log
        await supabase
            .from('study_logs')
            .update({
                study_minutes: studyMinutes,
                study_hours_formatted: formatted,
                logged_at: now
            })
            .eq('id', existingLog.id);
    } else {
        // Create new log
        await supabase
            .from('study_logs')
            .insert({
                id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                user_id: bot.id,
                user_name: bot.name,
                cycle_date: cycleDate,
                study_minutes: studyMinutes,
                study_hours_formatted: formatted,
                logged_at: now
            });
    }

    // Sign out
    await supabase.auth.signOut();
}

// Start server
app.listen(PORT, () => {
    console.log(`🤖 Bot Scheduler Server running on port ${PORT}`);
    console.log(`📡 Ready to receive schedules`);
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
