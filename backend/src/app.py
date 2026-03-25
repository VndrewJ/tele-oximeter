from flask import Flask, jsonify, abort, request
from flask_cors import CORS
from supabase import create_client
from dotenv import load_dotenv
import os
import uuid
from datetime import datetime

env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
load_dotenv(env_path) 

app = Flask(__name__)
app.secret_key = os.getenv('SECRET_KEY')
CORS(app, resources={r"/*": {"origins": "*"}})

# Initialize Supabase client
supabase = create_client(
    os.getenv('SUPABASE_URL'),
    os.getenv('SUPABASE_KEY')
)

@app.route("/session/new", methods=['POST'])
def create_session():
    """Create and return a new session key"""
    try:
        session_key = str(uuid.uuid4())[:6].upper()
        
        # Create session in Supabase
        result = supabase.table('sessions').insert({
            'session_key': session_key,
            'start_time': datetime.utcnow().isoformat()
        }).execute()
        
        return jsonify({
            'session_key': session_key,
            'message': 'Session created successfully'
        })
    except Exception as e:
        print(f"Error creating session: {e}")
        abort(500)

@app.route("/data/<session_key>")
def get_data(session_key):

    print(f"Looking for session_key: '{session_key}'")
    try:
        # Get session id
        session = supabase.table('sessions')\
            .select('id')\
            .eq('session_key', session_key)\
            .execute()\
            .data
        
        print(f"Found sessions: {session}")

        if not session:
            return jsonify({'error': 'Session not found'}), 404

        # Get health data
        result = supabase.table('health_data')\
            .select('*')\
            .eq('session_id', session[0]['id'])\
            .order('timestamp', desc=True)\
            .limit(50)\
            .execute()

        return jsonify(result.data)
    except Exception as e:
        print(f"Error: {e}")
        abort(500)

@app.route("/")
def home():
    return jsonify({
        "status": "online",
        "endpoints": {
            "create_session": "/session/new",
            "get_data": "/data/<session_key>"
        }
    })

if __name__ == "__main__":
    # Get port from Railway environment
    port = int(os.environ.get('PORT', 8080))
    # Run in production mode, on all interfaces
    app.run(host='0.0.0.0', port=port, debug=True)

