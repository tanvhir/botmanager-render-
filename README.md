# StreakUp Bot Scheduler - Render Server

This server receives bot schedules from the Bot Manager and automatically executes them at scheduled times.

## Features

- **Schedule Reception**: Accepts multi-day bot behavior schedules via REST API
- **Automated Execution**: Uses cron jobs to execute scheduled tasks at specific times
- **Realistic Timing**: Random delays between bot executions for natural behavior
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

1. **Schedule Reception**: The Bot Manager sends a complete schedule for multiple days
2. **Task Scheduling**: The server creates cron jobs for each day at 06:00 UTC
3. **Execution**: At the scheduled time, the server:
   - Signs in as each bot user
   - Logs the scheduled study hours to Supabase
   - Signs out and moves to the next bot with random delays
4. **Completion**: After all bots are processed, the day's execution is complete

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
