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
let executionHistory = [];

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
        scheduledTasks: scheduledTasks.size,
        executionHistoryCount: executionHistory.length
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

// Setup schedule execution with precise times
async function setupScheduleExecution(schedule) {
    const tasks = [];
    const startDate = new Date(schedule.startDate);

    console.log(`⏰ Setting up execution for schedule ${schedule.id} (Timezone: ${TIMEZONE})`);

    // Create individual jobs for each bot on each day at their specific execution time
    for (const botData of schedule.bots) {
        for (const [cycleDate, daySchedule] of Object.entries(botData.schedule)) {
            if (!daySchedule.shouldStudy || !daySchedule.executionTime || !daySchedule.executionDate) {
                continue;
            }

            // Parse the execution time (in BD time = UTC+6)
            const [hours, minutes] = daySchedule.executionTime.split(':').map(Number);

            // Use executionDate (when Render should execute) instead of cycleDate
            const executionDateBD = new Date(daySchedule.executionDate);
            executionDateBD.setHours(hours, minutes, 0, 0);

            // Convert BD time to UTC (subtract 6 hours)
            const executionDateUTC = new Date(executionDateBD.getTime() - (TIMEZONE_OFFSET * 60 * 60 * 1000));

            // Only schedule if the execution time is in the future
            if (executionDateUTC <= new Date()) {
                console.log(`  ⊘ Skipping ${botData.bot.name} - execution time has passed`);
                continue;
            }

            // Schedule the job in UTC
            const job = scheduleJob(executionDateUTC, async () => {
                console.log(`🚀 Executing ${botData.bot.name} at ${daySchedule.executionTime} BD (${executionDateUTC.toISOString()} UTC)`);
                console.log(`   Cycle Date (5 AM Rule): ${cycleDate}`);
                await executeSingleBot(botData.bot, cycleDate, daySchedule);
            });

            tasks.push(job);
            console.log(`  ✓ Scheduled ${botData.bot.name} for ${daySchedule.executionDate} at ${daySchedule.executionTime} BD (${executionDateUTC.toISOString()} UTC)`);
        }
    }

    scheduledTasks.set(schedule.id, tasks);
    console.log(`✓ Total ${tasks.length} tasks scheduled for schedule ${schedule.id}`);
}

// Execute a single bot at its scheduled time
async function executeSingleBot(bot, dateStr, daySchedule) {
    const executionRecord = {
        botName: bot.name,
        cycleDate: dateStr,
        executionTime: daySchedule.executionTime,
        studyHours: daySchedule.formatted,
        status: 'pending',
        timestamp: new Date().toISOString(),
        error: null
    };

    try {
        await logStudyHours(bot, dateStr, daySchedule.studyMinutes, daySchedule.formatted);
        executionRecord.status = 'success';
        console.log(`  ✓ ${bot.name}: ${daySchedule.formatted} at ${daySchedule.executionTime}`);
    } catch (error) {
        executionRecord.status = 'failed';
        executionRecord.error = error.message;
        console.error(`  ✗ ${bot.name} failed:`, error.message);
    }

    // Add to execution history
    executionHistory.push(executionRecord);

    // Keep only last 1000 execution records
    if (executionHistory.length > 1000) {
        executionHistory = executionHistory.slice(-1000);
    }
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
