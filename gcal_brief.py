#!/usr/bin/env python3
"""
Google Calendar integration - Prints auth URL for manual copy/paste
"""

import os
import pickle
from datetime import datetime
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']
CLIENT_CONFIG = {
    "installed": {
        "client_id": "935986916520-rv5ffk2f2fuk8sp7aoma0i4mbhibbfee.apps.googleusercontent.com",
        "project_id": "tajarib-calendar",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
        "client_secret": "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",
        "redirect_uris": ["urn:ietf:wg:oauth:2.0:oob", "http://localhost"]
    }
}

CALENDARS = {
    'personal': 'jameel.nedham@gmail.com',
    'tajarib': 'jameel@tajarib.show'
}

def get_credentials():
    """Get or refresh credentials - prints URL for manual auth"""
    token_path = '/root/.openclaw/workspace/tajarib/.gcal_token.pickle'
    
    if os.path.exists(token_path):
        with open(token_path, 'rb') as token:
            creds = pickle.load(token)
        
        if creds and creds.valid:
            return creds
        
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            with open(token_path, 'wb') as token:
                pickle.dump(creds, token)
            return creds
    
    # Need auth - print URL for manual copy/paste
    flow = InstalledAppFlow.from_client_config(CLIENT_CONFIG, SCOPES)
    
    # Generate auth URL
    auth_url, _ = flow.authorization_url(prompt='consent')
    
    print("\n" + "="*70)
    print("🔗 Google Calendar Authentication Required")
    print("="*70)
    print("\n📋 STEP 1: Copy this URL and open in your browser:")
    print(f"\n{auth_url}\n")
    print("📋 STEP 2: Sign in with Google and allow calendar access")
    print("📋 STEP 3: You'll get a code - paste it here and press Enter")
    print("="*70 + "\n")
    
    code = input("Enter the auth code: ").strip()
    
    flow.fetch_token(code=code)
    creds = flow.credentials
    
    print("✅ Authenticated successfully!\n")
    
    with open(token_path, 'wb') as token:
        pickle.dump(creds, token)
    
    return creds

def get_today_events(service, calendar_id='primary'):
    """Get today's events"""
    tz = 'Asia/Baghdad'
    now = datetime.now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = now.replace(hour=23, minute=59, second=59)
    
    try:
        result = service.events().list(
            calendarId=calendar_id,
            timeMin=start.isoformat() + 'Z',
            timeMax=end.isoformat() + 'Z',
            singleEvents=True,
            orderBy='startTime',
            timeZone=tz
        ).execute()
        return result.get('items', [])
    except Exception as e:
        print(f"  ⚠️  Error with {calendar_id}: {e}")
        return []

def format_event(event):
    """Format event"""
    start = event['start'].get('dateTime', event['start'].get('date'))
    summary = event.get('summary', 'Untitled')
    
    if 'T' in start:
        time = start.split('T')[1][:5]
    else:
        time = "All day"
    
    return f"{time} — {summary}"

def get_daily_brief():
    """Generate brief"""
    try:
        creds = get_credentials()
        service = build('calendar', 'v3', credentials=creds)
        
        events = []
        for name, cal_id in CALENDARS.items():
            for e in get_today_events(service, cal_id):
                events.append((name, e))
        
        if not events:
            return "📅 No events today. You're free!"
        
        events.sort(key=lambda x: x[1]['start'].get('dateTime', x[1]['start'].get('date')))
        
        lines = ["📅 Today's Schedule (Baghdad time):\n"]
        for cal, e in events:
            icon = "👤" if cal == 'personal' else "🎙️"
            lines.append(f"{icon} {format_event(e)}")
        
        return "\n".join(lines)
        
    except Exception as e:
        return f"❌ Error: {e}"

if __name__ == '__main__':
    print(get_daily_brief())
