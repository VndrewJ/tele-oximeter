from bleak import BleakScanner, BleakClient
from supabase import create_client
from dotenv import load_dotenv
import asyncio
import time
import os
import uuid
from datetime import datetime, timezone
import requests

# Load environment variables
env_path = os.path.join(os.path.dirname(__file__), ".env")
load_dotenv(env_path)

# Initialize Supabase
supabase = create_client(
    os.getenv('SUPABASE_URL'),
    os.getenv('SUPABASE_KEY')
)

# Get API URL from environment variables
API_URL = os.getenv('API_URL')
if not API_URL:
    raise ValueError("API_URL not found in environment variables")

DEVICE_ADDRESS = ""
CHAR_UUID = ""
Write_Interval = 5  # seconds

# Store the latest data
latest_data = {"hr": None, "spo2": None, "timestamp": None}
data_buffer = []
current_session_id = None
session_key = None


async def request_session():
    """Request a new session key from the server."""
    try:
        response = requests.post(f'{API_URL}/session/new')
        if response.ok:
            data = response.json()
            session_key = data['session_key']
            print(f"Created new session: {session_key}")
            return session_key
        else:
            raise Exception(f"Failed to create session: {response.status_code}")
    except Exception as e:
        print(f"Error creating session: {e}")
        return None


async def find_device():
    global DEVICE_ADDRESS, CHAR_UUID

    devices = await BleakScanner.discover()

    for d in devices:
        if d.name == "BLT_M70C":  # Replace with your device name
            print(f"Found device: {d.name} - {d.address}")
            DEVICE_ADDRESS = d.address
            break

    if not DEVICE_ADDRESS:
        return -1

    async with BleakClient(DEVICE_ADDRESS) as client:
        services = client.services
        for service in services:
            for char in service.characteristics:
                if "notify" in char.properties:
                    return char.uuid

    return -1


def notification_handler(sender, data: bytearray):
    """Parse HR and SpO₂ from raw data frame."""
    global latest_data, data_buffer, current_session_id
    raw = list(data)

    if len(raw) < 19:
        return

    try:
        if raw[18] == 255 and not (raw[15] == 255 and raw[16] == 127 and raw[17] == 255):
            spo2 = raw[16]
            hr = raw[17]
            ts = int(time.time())
            data_buffer.append({
                'session_id': current_session_id,
                'timestamp': ts,
                'spo2': spo2,
                'pulse': hr
            })
            print(f"Session {session_key} -> HR={hr}, SpO₂={spo2}")
    except Exception as e:
        print("Parse error:", e)


async def db_writer():
    """Background task to write buffer to Supabase every interval."""
    global data_buffer

    while True:
        await asyncio.sleep(Write_Interval)
        if data_buffer:
            try:
                # Insert batch of readings
                result = supabase.table('health_data').insert(data_buffer).execute()
                print(f"DB appended with {len(data_buffer)} rows for session {session_key}")
                data_buffer = []  # clear buffer
            except Exception as e:
                print("DB write error:", e)


async def main():
    global current_session_id, session_key
    
    # Get session key from server first
    session_key = await request_session()
    if not session_key:
        print("Could not create session. Exiting.")
        return

    # Get the session ID from Supabase using the session key
    try:
        session = supabase.table('sessions')\
            .select('id')\
            .eq('session_key', session_key)\
            .execute()\
            .data
        
        if not session:
            print("Session not found in database. Exiting.")
            return
            
        current_session_id = session[0]['id']
        print(f"Session ID: {current_session_id}")
    except Exception as e:
        print(f"Error fetching session ID: {e}")
        return

    print(f"Starting data collection with session key: {session_key}")
    print("Share this session key with the person viewing the data.")

    global DEVICE_ADDRESS, CHAR_UUID

    # Find device
    CHAR_UUID = await find_device()
    if CHAR_UUID == -1:
        print("Device not found.")
        return

    print(f"Using characteristic: {CHAR_UUID}")

    async with BleakClient(DEVICE_ADDRESS) as client:
        print(f"Connected. Starting session {session_key}")
        await client.start_notify(CHAR_UUID, notification_handler)

        # Run DB writer in parallel
        writer_task = asyncio.create_task(db_writer())

        try:
            # Run indefinitely until interrupted
            await asyncio.Event().wait()
        except (KeyboardInterrupt, asyncio.CancelledError):
            print(f"Stopping session {session_key}...")

        await client.stop_notify(CHAR_UUID)
        writer_task.cancel()
        print(f"Session {session_key} stopped.")


if __name__ == "__main__":
    asyncio.run(main())
