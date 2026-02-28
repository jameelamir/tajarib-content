#!/usr/bin/env python3
"""
Google Calendar integration - Manual OAuth URL generation
"""

import os
import pickle
import urllib.parse
from datetime import datetime
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']
CLIENT_ID = "935986916520-rv5ffk2f2fuk8sp7aoma0i4mbhibbfee.apps.googleusercontent.com"
CLIENT_SECRET = "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"
REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob"  # For manual copy/paste

CALENDARS = {
    'personal': 'jameel.nedham@gmail.com',
    'tajarib': 'jameel@tajarib.show'
}

def get_auth_url():
    """Generate OAuth URL for manual auth"""
    params = {
        'response_type': 'code',
        'client_id': CLIENT_ID,
        'redirect_uri': REDIRECT_URI,
        'scope': ' '.join(SCOPES),
        'access_type': 'offline',
        'prompt': 'consent'
    }
    
    base_url = "https://accounts.google.com/o/oauth2/auth"
    query = urllib.parse.urlencode(params)
    return f"{base_url}?{query}"

def exchange_code_for_token(code):
    """Exchange auth code for credentials"""
    import requests
    
    token_url = "https://oauth2.googleapis.com/token"
    data = {
        'code': code,
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
        'redirect_uri': REDIRECT_URI,
        'grant_type': 'authorization_code'
    }
    
    response = requests.post(token_url, data=data)
    token_data = response.json()
    
    if 'error' in token_data:
        raise Exception(f"Token exchange failed: {token_data}")
    
    return Credentials(
        token=token_data['access_token'],
        refresh_token=token_data.get('refresh_token'),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        scopes=SCOPES
    )

def get_credentials():
    """Get or refresh credentials"""
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
    
    # Print auth URL and wait for code
    auth_url = get_auth_url()
    
    print("\n" + "="*70)
    print("🔗 Google Calendar Authentication")
    print("="*70)
    print("\n📋 STEP 1: Open this URL in your browser:")
    print(f"\n{auth_url}\n")
    print("📋 STEP 2: Sign in and allow access")
    print("📋 STEP 3: Copy the code shown and paste it below")
    print("="*70)
    
    return None  # Will be handled by manual code entry

def save_credentials(creds):
    """Save credentials to file"""
    token_path = '/root/.openclaw/workspace/tajarib/.gcal_token.pickle'
    with open(token_path, 'wb') as token:
        pickle.dump(creds, token)
    print("✅ Credentials saved!\n")

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

def get_daily_brief(creds=None):
    """Generate brief"""
    try:
        if creds is None:
            creds = get_credentials()
            if creds is None:
                return None  # Need manual auth
        
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
    result = get_daily_brief()
    if result is None:
        print("\nWaiting for auth code...")
    else:
        print(result)
