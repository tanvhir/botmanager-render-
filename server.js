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

// Fetch all active schedules from bot-manager DB on startup
async function recoverSchedulesFromDB() {
    try {
        console.log('🔄 Recovering schedules from bot-manager database...');
        
        // Fetch all active schedules
        const { data: schedules, error: schedulesError } = await botManagerSupabase
            .from('bot_manager_schedules')
            .select('*')
            .eq('status', 'active');
        
        if (schedulesError) throw schedulesError;
        
        if (!schedules || schedules.length === 0) {
            console.log('✓ No active schedules found in database');
            return;
        }
        
        console.log(`📋 Found ${schedules.length} active schedules in database`);
        
        // Fetch all pending executions for these schedules
        const scheduleIds = schedules.map(s => s.id);
        const { data: executions, error: execError } = await botManagerSupabase
            .from('bot_manager_scheduled_executions')
            .select('*')
            .in('schedule_id', scheduleIds)
            .eq('status', 'pending');
        
        if (execError) throw execError;
        
        console.log(`📋 Found ${executions?.length || 0} pending executions`);
        
        // Fetch bot details
        const botIds = [...new Set(executions?.map(e => e.bot_id) || [])];
        const { data: bots, error: botsError } = await botManagerSupabase
            .from('bot_manager_bots')
            .select('*')
            .in('id', botIds);
        
        if (botsError) throw botsError;
        
        // Reconstruct schedules in memory format
        for (const schedule of schedules) {
            const scheduleExecutions = executions?.filter(e => e.schedule_id === schedule.id) || [];
            const scheduleBots = [];
            
            for (const bot of bots || []) {
                const botExecutions = scheduleExecutions.filter(e => e.bot_id === bot.id);
                if (botExecutions.length > 0) {
                    const botSchedule = {};
                    botExecutions.forEach(exec => {
                        // Use target_hours from execution entry if available, otherwise use bot's default
                        const targetHours = exec.target_hours || (bot.target_hours_per_day || 6);
                        const shouldStudy = exec.behavior !== 'miss';
                        
                        botSchedule[exec.scheduled_date] = {
                            shouldStudy: shouldStudy,
                            executionDate: exec.scheduled_date,
                            executionTime: '09:00', // Default time, can be configured
                            studyMinutes: targetHours * 60,
                            formatted: `${targetHours}h`,
                            executionId: exec.id, // Store execution ID for status updates
                            behavior: exec.behavior || 'continue'
                        };
                    });
                    
                    scheduleBots.push({
                        bot: {
                            id: bot.id,
                            name: bot.name,
                            email: bot.email,
                            password: bot.password
                        },
                        schedule: botSchedule
                    });
                }
            }
            
            if (scheduleBots.length > 0) {
                const scheduleWithId = {
                    id: schedule.id,
                    startDate: schedule.start_date,
                    endDate: schedule.end_date,
                    bots: scheduleBots,
                    receivedAt: schedule.created_at,
                    status: 'active',
                    fromDB: true
                };
                
                activeSchedules.push(scheduleWithId);
                await setupScheduleExecution(scheduleWithId);
                console.log(`✓ Recovered schedule: ${schedule.name}`);
            }
        }
        
        console.log(`✓ Successfully recovered ${activeSchedules.length} schedules`);
    } catch (error) {
        console.error('❌ Error recovering schedules:', error);
    }
}

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

        // Save schedule to bot manager database
        try {
            const { error: dbError } = await botManagerSupabase
                .from('bot_manager_schedules')
                .insert({
                    id: scheduleId,
                    name: `Schedule ${new Date().toISOString().split('T')[0]}`,
                    schedule_data: scheduleWithId,
                    status: 'active',
                    start_date: schedule.startDate,
                    end_date: schedule.endDate
                });

            if (dbError) {
                console.error('⚠️ Failed to save schedule to database:', dbError);
            } else {
                console.log('✓ Schedule saved to bot manager database');
            }
        } catch (dbError) {
            console.error('⚠️ Database error:', dbError);
        }

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
app.delete('/api/schedules/:id', async (req, res) => {
    const { id } = req.params;
    
    // Cancel all tasks for this schedule
    if (scheduledTasks.has(id)) {
        const tasks = scheduledTasks.get(id);
        tasks.forEach(task => task.stop());
        scheduledTasks.delete(id);
    }

    // Remove from active schedules
    activeSchedules = activeSchedules.filter(s => s.id !== id);

    // Delete from bot manager database
    try {
        const { error: dbError } = await botManagerSupabase
            .from('bot_manager_schedules')
            .delete()
            .eq('id', id);

        if (dbError) {
            console.error('⚠️ Failed to delete schedule from database:', dbError);
        } else {
            console.log('✓ Schedule deleted from bot manager database');
        }
    } catch (dbError) {
        console.error('⚠️ Database error:', dbError);
    }

    res.json({ success: true, message: 'Schedule deleted' });
});

// Health check with more details
app.get('/health', (req, res) => {
    const now = new Date();
    const upcomingTasks = [];
    
    // Count upcoming tasks in next 24 hours
    scheduledTasks.forEach((tasks, scheduleId) => {
        tasks.forEach(task => {
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
    });

    res.json({
        status: 'healthy',
        timestamp: now.toISOString(),
        activeSchedules: activeSchedules.length,
        scheduledTasks: scheduledTasks.size,
        executionHistoryCount: executionHistory.length,
        upcomingTasksCount: upcomingTasks.length,
        upcomingTasks: upcomingTasks.slice(0, 10) // Show next 10 tasks
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

// API endpoint to fetch pending executions from bot-manager DB
app.get('/api/bot-manager/pending-executions', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        const { data: executions, error } = await botManagerSupabase
            .from('bot_manager_scheduled_executions')
            .select('*')
            .eq('status', 'pending')
            .lte('scheduled_date', today)
            .order('scheduled_date', { ascending: true });
        
        if (error) throw error;
        
        // Fetch bot details
        const botIds = [...new Set(executions?.map(e => e.bot_id) || [])];
        const { data: bots, error: botsError } = await botManagerSupabase
            .from('bot_manager_bots')
            .select('*')
            .in('id', botIds);
        
        if (botsError) throw botsError;
        
        // Enrich with bot details
        const enrichedData = (executions || []).map(exec => {
            const bot = bots?.find(b => b.id === exec.bot_id);
            return {
                ...exec,
                bot_name: bot ? bot.name : 'Unknown',
                bot_email: bot ? bot.email : null,
                bot_password: bot ? bot.password : null,
                target_hours: bot ? bot.target_hours_per_day : 6
            };
        });
        
        res.json({ success: true, data: enrichedData });
    } catch (error) {
        console.error('Error fetching pending executions:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint to update execution status in bot-manager DB
app.post('/api/bot-manager/update-execution', async (req, res) => {
    try {
        const { executionId, status, result } = req.body;
        
        if (!executionId || !status) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        // Update execution status
        const { error } = await botManagerSupabase
            .from('bot_manager_scheduled_executions')
            .update({
                status: status,
                executed_at: new Date().toISOString(),
                result: result || {}
            })
            .eq('id', executionId);
        
        if (error) throw error;
        
        // Fetch execution details for history
        const { data: exec, error: execError } = await botManagerSupabase
            .from('bot_manager_scheduled_executions')
            .select('*')
            .eq('id', executionId)
            .single();
        
        if (execError) throw execError;
        
        // Add to executions history
        const { data: bot, error: botError } = await botManagerSupabase
            .from('bot_manager_bots')
            .select('*')
            .eq('id', exec.bot_id)
            .single();
        
        if (botError) throw botError;
        
        await botManagerSupabase
            .from('bot_manager_executions')
            .insert([{
                bot_id: exec.bot_id,
                bot_name: bot ? bot.name : 'Unknown',
                study_hours: result?.hours || 0,
                status: status,
                timestamp: new Date().toISOString()
            }]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating execution status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint to get all schedules from bot-manager DB
app.get('/api/bot-manager/schedules', async (req, res) => {
    try {
        const { data: schedules, error: schedulesError } = await botManagerSupabase
            .from('bot_manager_schedules')
            .select('*')
            .eq('status', 'active');
        
        if (schedulesError) throw schedulesError;
        
        const scheduleIds = (schedules || []).map(s => s.id);
        const { data: executions, error: execError } = await botManagerSupabase
            .from('bot_manager_scheduled_executions')
            .select('*')
            .in('schedule_id', scheduleIds)
            .eq('status', 'pending');
        
        if (execError) throw execError;
        
        const botIds = [...new Set(executions?.map(e => e.bot_id) || [])];
        const { data: bots, error: botsError } = await botManagerSupabase
            .from('bot_manager_bots')
            .select('*')
            .in('id', botIds);
        
        if (botsError) throw botsError;
        
        const enrichedExecutions = (executions || []).map(exec => {
            const bot = bots?.find(b => b.id === exec.bot_id);
            return {
                ...exec,
                bot_name: bot ? bot.name : 'Unknown',
                bot_email: bot ? bot.email : null,
                bot_password: bot ? bot.password : null,
                target_hours: bot ? bot.target_hours_per_day : 6
            };
        });
        
        res.json({
            success: true,
            schedules: schedules || [],
            executions: enrichedExecutions
        });
    } catch (error) {
        console.error('Error fetching schedules:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Detailed status dashboard endpoint
app.get('/api/status-dashboard', async (req, res) => {
    try {
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        
        // Get active schedules from database
        const { data: schedules, error: schedulesError } = await botManagerSupabase
            .from('bot_manager_schedules')
            .select('*')
            .eq('status', 'active');
        
        if (schedulesError) throw schedulesError;
        
        const scheduleIds = (schedules || []).map(s => s.id);
        
        // Get all executions for these schedules
        const { data: executions, error: execError } = await botManagerSupabase
            .from('bot_manager_scheduled_executions')
            .select('*')
            .in('schedule_id', scheduleIds);
        
        if (execError) throw execError;
        
        // Get recent execution history
        const { data: recentHistory, error: historyError } = await botManagerSupabase
            .from('bot_manager_executions')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(20);
        
        if (historyError) throw historyError;
        
        // Categorize executions
        const pendingExecutions = (executions || []).filter(e => e.status === 'pending');
        const completedExecutions = (executions || []).filter(e => e.status === 'success');
        const failedExecutions = (executions || []).filter(e => e.status === 'failed');
        const skippedExecutions = (executions || []).filter(e => e.status === 'skipped');
        
        // Count upcoming executions (next 24 hours)
        const upcomingCount = pendingExecutions.filter(e => {
            const execDate = new Date(e.scheduled_date);
            return execDate > now && execDate < new Date(now.getTime() + 24 * 60 * 60 * 1000);
        }).length;
        
        // Count today's executions
        const todayExecutions = (executions || []).filter(e => e.scheduled_date === today);
        const todayCompleted = todayExecutions.filter(e => e.status === 'success').length;
        const todayFailed = todayExecutions.filter(e => e.status === 'failed').length;
        
        res.json({
            success: true,
            timestamp: now.toISOString(),
            server: {
                status: 'healthy',
                uptime: process.uptime(),
                activeSchedules: activeSchedules.length,
                scheduledTasks: scheduledTasks.size,
                memoryUsage: process.memoryUsage()
            },
            schedules: {
                total: schedules?.length || 0,
                active: schedules?.length || 0
            },
            executions: {
                total: executions?.length || 0,
                pending: pendingExecutions.length,
                completed: completedExecutions.length,
                failed: failedExecutions.length,
                skipped: skippedExecutions.length,
                upcoming: upcomingCount,
                today: {
                    total: todayExecutions.length,
                    completed: todayCompleted,
                    failed: todayFailed
                }
            },
            recentHistory: recentHistory || [],
            upcomingTasks: pendingExecutions
                .filter(e => new Date(e.scheduled_date) > now)
                .sort((a, b) => new Date(a.scheduled_date) - new Date(b.scheduled_date))
                .slice(0, 10)
        });
    } catch (error) {
        console.error('Error fetching status dashboard:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Setup schedule execution with precise times
async function setupScheduleExecution(schedule) {
    const tasks = [];
    const startDate = new Date(schedule.startDate);

    console.log(`⏰ Setting up execution for schedule ${schedule.id} (Timezone: ${TIMEZONE})`);

    // Create individual jobs for each bot on each day at their specific execution time
    for (const botData of schedule.bots) {
        for (const [cycleDate, daySchedule] of Object.entries(botData.schedule)) {
            if (!daySchedule.executionTime || !daySchedule.executionDate) {
                continue;
            }

            // Skip if bot should not study (miss behavior)
            if (!daySchedule.shouldStudy) {
                console.log(`  ⊘ Skipping ${botData.bot.name} for ${cycleDate} - behavior: miss`);
                // Still update status in bot-manager DB
                if (daySchedule.executionId) {
                    await updateBotManagerExecutionStatus(daySchedule.executionId, 'skipped', {
                        reason: 'Miss behavior',
                        hours: 0
                    });
                }
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
                console.log(`   Behavior: ${daySchedule.behavior || 'continue'}, Target: ${daySchedule.formatted}`);
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
        
        // Update status in bot-manager DB if this is a DB-recovered schedule
        if (daySchedule.executionId) {
            await updateBotManagerExecutionStatus(daySchedule.executionId, 'success', {
                hours: daySchedule.formatted,
                minutes: daySchedule.studyMinutes
            });
        }
    } catch (error) {
        executionRecord.status = 'failed';
        executionRecord.error = error.message;
        console.error(`  ✗ ${bot.name} failed:`, error.message);
        
        // Update status in bot-manager DB if this is a DB-recovered schedule
        if (daySchedule.executionId) {
            await updateBotManagerExecutionStatus(daySchedule.executionId, 'failed', {
                error: error.message
            });
        }
    }

    // Add to execution history
    executionHistory.push(executionRecord);

    // Keep only last 1000 execution records
    if (executionHistory.length > 1000) {
        executionHistory = executionHistory.slice(-1000);
    }

    // Save execution to bot manager database
    try {
        const { error: dbError } = await botManagerSupabase
            .from('bot_manager_executions')
            .insert({
                bot_id: bot.id,
                bot_name: executionRecord.botName,
                cycle_date: executionRecord.cycleDate,
                execution_time: executionRecord.executionTime,
                study_hours: executionRecord.studyHours,
                status: executionRecord.status,
                timestamp: executionRecord.timestamp,
                error_message: executionRecord.error
            });

        if (dbError) {
            console.error('⚠️ Failed to save execution to database:', dbError);
        }
    } catch (dbError) {
        console.error('⚠️ Database error:', dbError);
    }
}

// Update execution status in bot-manager DB
async function updateBotManagerExecutionStatus(executionId, status, result) {
    try {
        const { error } = await botManagerSupabase
            .from('bot_manager_scheduled_executions')
            .update({
                status: status,
                executed_at: new Date().toISOString(),
                result: result || {}
            })
            .eq('id', executionId);
        
        if (error) throw error;
        
        console.log(`  ✓ Updated execution status in bot-manager DB: ${executionId} -> ${status}`);
    } catch (error) {
        console.error(`  ✗ Failed to update execution status in bot-manager DB:`, error.message);
    }
}

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

    // Check if log exists for the date
    const { data: existingLog } = await streakupSupabase
        .from('study_logs')
        .select('*')
        .eq('user_id', bot.id)
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
                user_id: bot.id,
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
    console.log(`📡 Ready to receive schedules`);
    
    // Recover schedules from database on startup
    await recoverSchedulesFromDB();
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
