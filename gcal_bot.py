#!/usr/bin/env python3
"""
Google Calendar - Manual OAuth, store refresh token
"""

import os
import json
import pickle
from datetime import datetime
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = ['https://www.googleapis.com/auth/calendar']  # Read + write
CLIENT_ID = "935986916520-rv5ffk2f2fuk8sp7aoma0i4mbhibbfee.apps.googleusercontent.com"
CLIENT_SECRET = "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"
TOKEN_PATH = '/root/.openclaw/workspace/tajarib/.gcal_credentials.pickle'

CALENDARS = {
    'personal': 'primary',  # Will use authenticated user's primary
    'tajarib': None  # You'll specify this after auth
}

def print_auth_instructions():
    """Print URL for manual OAuth"""
    from urllib.parse import urlencode
    
    # Use localhost redirect - user will copy code from browser
    params = {
        'client_id': CLIENT_ID,
        'redirect_uri': 'http://localhost:8080',
        'scope': ' '.join(SCOPES),
        'response_type': 'code',
        'access_type': 'offline',
        'prompt': 'consent'
    }
    
    url = f"https://accounts.google.com/o/oauth2/auth?{urlencode(params)}"
    
    print("\n" + "="*70)
    print("🔗 Google Calendar OAuth")
    print("="*70)
    print("\n1. Open this URL in your browser:")
    print(f"\n{url}\n")
    print("2. Sign in with Google")
    print("3. Allow calendar access")
    print("4. You'll see an error page 'localhost refused to connect' - THAT'S OK")
    print("5. Copy the CODE from the URL (after 'code=' and before '&')")
    print("\n   Example: http://localhost:8080/?code=4/abc123...&scope=...")
    print("            ^^^^^^^^^^^^ copy this part")
    print("\n6. Paste the code below")
    print("="*70 + "\n")

def exchange_code(code):
    """Exchange auth code for credentials"""
    import requests
    
    response = requests.post('https://oauth2.googleapis.com/token', data={
        'code': code,
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
        'redirect_uri': 'http://localhost:8080',
        'grant_type': 'authorization_code'
    })
    
    data = response.json()
    
    if 'error' in data:
        raise Exception(f"Token error: {data}")
    
    creds = Credentials(
        token=data['access_token'],
        refresh_token=data.get('refresh_token'),
        token_uri='https://oauth2.googleapis.com/token',
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        scopes=SCOPES
    )
    
    # Save credentials
    with open(TOKEN_PATH, 'wb') as f:
        pickle.dump(creds, f)
    
    print("✅ Credentials saved!")
    print(f"   Access token expires in: {data.get('expires_in', 'unknown')}s")
    print(f"   Refresh token: {'Yes' if data.get('refresh_token') else 'No (re-auth needed)'}")
    
    return creds

def get_credentials():
    """Load or refresh credentials"""
    if not os.path.exists(TOKEN_PATH):
        return None
    
    with open(TOKEN_PATH, 'rb') as f:
        creds = pickle.load(f)
    
    if creds and creds.valid:
        return creds
    
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        with open(TOKEN_PATH, 'wb') as f:
            pickle.dump(creds, f)
        return creds
    
    return None

def setup():
    """Initial setup - get tokens from user"""
    print_auth_instructions()
    
    code = input("Paste the authorization code: ").strip()
    if not code:
        print("No code provided.")
        return
    
    try:
        creds = exchange_code(code)
        print("\n🎉 Setup complete! You can now use the calendar bot.")
    except Exception as e:
        print(f"❌ Error: {e}")

def get_daily_brief():
    """Get today's events"""
    creds = get_credentials()
    if not creds:
        return "❌ Not authenticated. Run: python gcal_bot.py setup"
    
    service = build('calendar', 'v3', credentials=creds)
    
    tz = 'Asia/Baghdad'
    now = datetime.now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = now.replace(hour=23, minute=59, second=59)
    
    events_result = service.events().list(
        calendarId='primary',
        timeMin=start.isoformat() + 'Z',
        timeMax=end.isoformat() + 'Z',
        singleEvents=True,
        orderBy='startTime',
        timeZone=tz
    ).execute()
    
    events = events_result.get('items', [])
    
    if not events:
        return "📅 No events today."
    
    lines = ["📅 Today's Schedule (Baghdad time):\n"]
    for e in events:
        start = e['start'].get('dateTime', e['start'].get('date'))
        summary = e.get('summary', 'Untitled')
        if 'T' in start:
            time = start.split('T')[1][:5]
        else:
            time = "All day"
        lines.append(f"• {time} — {summary}")
    
    return "\n".join(lines)

def add_event(summary, start_time, end_time=None, calendar_id='primary'):
    """Add a calendar event"""
    creds = get_credentials()
    if not creds:
        return "❌ Not authenticated."
    
    service = build('calendar', 'v3', credentials=creds)
    
    if end_time is None:
        # Default 1 hour duration
        from datetime import timedelta
        end_time = (datetime.fromisoformat(start_time.replace('Z', '+00:00')) + timedelta(hours=1)).isoformat()
    
    event = {
        'summary': summary,
        'start': {'dateTime': start_time, 'timeZone': 'Asia/Baghdad'},
        'end': {'dateTime': end_time, 'timeZone': 'Asia/Baghdad'}
    }
    
    result = service.events().insert(calendarId=calendar_id, body=event).execute()
    return f"✅ Added: {result.get('htmlLink')}"

if __name__ == '__main__':
    import sys
    
    if len(sys.argv) > 1 and sys.argv[1] == 'setup':
        setup()
    else:
        print(get_daily_brief())
