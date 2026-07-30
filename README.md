# StreakUp Bot Scheduler - Render Server

This server receives bot schedules from the Bot Manager and automatically executes them at scheduled times.

## Features

- **Schedule Reception**: Accepts multi-day bot behavior schedules via REST API
- **Precise Time Scheduling**: Executes each bot at their specific random execution time
- **Timezone Support**: Built-in support for Bangladesh time (UTC+6)
- **Realistic Timing**: Random execution times within specified ranges for natural behavior
- **Health Monitoring**: Endpoints to check active schedules and server status

## Environment Variables

Set these environment variables in your Render dashboard:

```
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
PORT=3000
```

## Deployment to Render

1. **Create a new Web Service** on Render
2. **Connect your GitHub repository** containing this folder
3. **Configure Build & Run**:
   - Build Command: `npm install`
   - Start Command: `node server.js`
4. **Add Environment Variables** from above
5. **Deploy**

## API Endpoints

### POST /api/schedule
Receive a new bot schedule.

**Request Body:**
```json
{
  "startDate": "2026-07-31",
  "endDate": "2026-08-06",
  "days": 7,
  "percentage": 60,
  "minHours": 4,
  "maxHours": 10,
  "bots": [
    {
      "bot": {
        "id": "user_id",
        "name": "Bot Name",
        "email": "bot@example.com",
        "password": "password"
      },
      "pattern": "consistent_streak",
      "schedule": {
        "2026-07-31": {
          "shouldStudy": true,
          "studyMinutes": 300,
          "hours": 5,
          "minutes": 0,
          "formatted": "5h 0m"
        }
      }
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "scheduleId": "uuid",
  "message": "Schedule received and tasks scheduled successfully",
  "summary": {
    "startDate": "2026-07-31",
    "endDate": "2026-08-06",
    "totalBots": 10,
    "totalTasks": 70
  }
}
```

### GET /api/schedules
Get all active schedules.

**Response:**
```json
{
  "activeSchedules": [
    {
      "id": "uuid",
      "startDate": "2026-07-31",
      "endDate": "2026-08-06",
      "bots": 10,
      "status": "active",
      "receivedAt": "2026-07-30T12:00:00.000Z"
    }
  ]
}
```

### DELETE /api/schedules/:id
Delete a schedule and cancel all its tasks.

### GET /health
Health check endpoint.

## How It Works

1. **Schedule Reception**: The Bot Manager sends a complete schedule with specific execution times for each bot/day
2. **Time Conversion**: Execution times (in BD time = UTC+6) are converted to UTC for scheduling
3. **Task Scheduling**: The server creates individual scheduled jobs for each bot at their specific execution time
4. **Execution**: At the scheduled time, the server:
   - Signs in as the bot user
   - Logs the scheduled study hours to Supabase
   - Signs out
5. **Completion**: Each bot executes independently at their assigned random time

## Time-Based Scheduling

The system supports realistic timing control:

- **Execution Time Range**: Set start and end times (e.g., 7:00 AM to 3:00 PM BD time)
- **Random Times**: Each bot gets a random execution time within the range for each day
- **Timezone Support**: All times are in Bangladesh time (UTC+6) and automatically converted to UTC
- **Individual Scheduling**: Each bot has its own execution time, not all executing at once

**Example Schedule:**
```
Bot 1: 7:00 AM on Day 1, 8:30 AM on Day 2, 9:15 AM on Day 3...
Bot 2: 7:45 AM on Day 1, 10:00 AM on Day 2, 2:30 PM on Day 3...
Bot 3: 8:15 AM on Day 1, 11:30 AM on Day 2, 1:00 PM on Day 3...
```

This creates realistic, staggered entry times that mimic natural user behavior.

## Behavior Patterns

The scheduler supports 5 realistic behavior patterns:

- **🟢 Consistent**: Studies every day with varied hours
- **🟡 Intermittent**: Studies most days, misses 1-2 random days
- **🔵 Late Start**: Starts after 2-3 days
- **🟠 Early Stop**: Stops after 3-4 days
- **⚫ Inactive**: No activity

## Security Notes

- Bot credentials are stored in the schedule (ensure HTTPS)
- Each bot signs in/out individually to respect RLS policies
- Consider adding API key authentication for production use

## Local Development

```bash
npm install
npm run dev
```

The server will start on port 3000 (or PORT env var).
