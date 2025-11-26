import { useState, useEffect, memo } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { createClient } from '@supabase/supabase-js';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts';
import './App.css';

// Create Supabase client for real-time updates only
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    realtime: {
      params: {
        eventsPerSecond: 10
      }
    },
    db: {
      schema: 'public'
    },
    auth: {
      persistSession: false
    }
  }
);

// Get API URL from environment variable
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

function Home() {
  const navigate = useNavigate();
  const [sessionKey, setSessionKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!sessionKey.trim()) return;

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_URL}/data/${sessionKey}`);
      if (!response.ok) {
        throw new Error('Invalid session key');
      }
      navigate(`/data/${sessionKey}`);
    } catch (err) {
      setError('Invalid session key. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="home-container">
      <h1>Welcome to the IoT Oximeter Project</h1>
      <p>Enter your session key to view data:</p>
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          value={sessionKey}
          onChange={(e) => {
            setSessionKey(e.target.value.toUpperCase());
            setError(''); // Clear error when input changes
          }}
          placeholder="Enter session key"
          maxLength={6}
          style={{ marginRight: '10px' }}
          disabled={loading}
        />
        <button type="submit" disabled={loading}>
          {loading ? 'Checking...' : 'View Data'}
        </button>
      </form>
      {error && (
        <p style={{ color: 'red', marginTop: '10px' }}>
          {error}
        </p>
      )}
    </div>
  );
}

const SpO2Graph = memo(({ data }) => (
  <div className="vitals-graph">
    <h3>SpO₂ (%)</h3>
    <ResponsiveContainer>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="timestamp"
          tickFormatter={(t) =>
            new Date(t * 1000).toLocaleTimeString()
          }
          label={{ value: "Time", position: "insideBottom", offset: -5 }}
        />
        <YAxis domain={[85, 100]} />
        <Tooltip
          labelFormatter={(t) =>
            new Date(t * 1000).toLocaleTimeString()
          }
        />
        <Legend />
        <Line
          type="monotone"
          dataKey="spo2"
          stroke="#8884d8"
          name="SpO₂"
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  </div>
));

const PulseGraph = memo(({ data }) => (
  <div className="vitals-graph">
    <h3>Pulse (BPM)</h3>
    <ResponsiveContainer>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="timestamp"
          tickFormatter={(t) =>
            new Date(t * 1000).toLocaleTimeString()
          }
          label={{ value: "Time", position: "insideBottom", offset: -5 }}
        />
        <YAxis />
        <Tooltip
          labelFormatter={(t) =>
            new Date(t * 1000).toLocaleTimeString()
          }
        />
        <Legend />
        <Line
          type="monotone"
          dataKey="pulse"
          stroke="#82ca9d"
          name="Pulse"
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  </div>
));

function DataPage() {
  const navigate = useNavigate();
  const [data, setData] = useState([]);
  const [error, setError] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const sessionKey = window.location.pathname.split('/')[2]; // Get session key from URL

  // helper: ensure consistent formatting
  const formatBuffer = (buffer) =>
    buffer.map((row, i) => ({
      timestamp: Number(row["timestamp"]),
      spo2: Number(row["spo2"]),
      pulse: Number(row["pulse"]),
      idx: i
    }));

  // First effect: fetch initial data and get session ID
  useEffect(() => {
    if (!sessionKey) {
      navigate('/');
      return;
    }

    const fetchData = async () => {
      try {
        const response = await fetch(`${API_URL}/data/${sessionKey}`);
        if (!response.ok) throw new Error('Session not found');
        const json = await response.json();
        setData(formatBuffer(json));
        setError(false);
        
        // Get session ID from the first data point if available
        if (json.length > 0 && json[0].session_id) {
          setSessionId(json[0].session_id);
        } else {
          // If no data yet, fetch session ID from sessions table
          const sessionResponse = await supabase
            .from('sessions')
            .select('id')
            .eq('session_key', sessionKey)
            .single();
          
          if (sessionResponse.data) {
            setSessionId(sessionResponse.data.id);
          }
        }
      } catch (err) {
        console.error('Error fetching data:', err);
        setError(true);
      }
    };

    fetchData();
  }, [sessionKey, navigate]);

  // Second effect: set up real-time subscription once we have session ID
  useEffect(() => {
    if (!sessionId) return;

    console.log('Setting up real-time subscription for session ID:', sessionId);

    const subscription = supabase
      .channel(`health_data_${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'health_data',
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => {
          console.log('Received real-time update:', payload);
          setData((prev) => {
            const newRow = payload.new;
            return [
              ...prev.slice(-99), // keep last 100 points
              {
                timestamp: Number(newRow.timestamp),
                spo2: Number(newRow.spo2),
                pulse: Number(newRow.pulse),
              },
            ];
          });
        }
      )
      .subscribe((status) => {
        console.log('Subscription status:', status);
      });

    return () => {
      console.log('Unsubscribing from real-time updates');
      subscription.unsubscribe();
    };
  }, [sessionId]);

  // Sort once: oldest → newest
  const ascending = [...data].sort((a, b) => a.timestamp - b.timestamp);

  // Graph wants oldest → newest (natural order)
  const graphData = ascending;

  // Table wants newest → oldest (but only last 20)
  const tableData = ascending.slice(-20).reverse();

  return (
    <div>
      <h2>Session: {sessionKey}</h2>
      {error ? (
        <p style={{ color: 'red' }}>
          Error connecting to server. Please try again later.
        </p>
      ) : data.length === 0 ? (
        <p>Waiting for data...</p>
      ) : (
        <>
          {/* Table - uses sortedData (newest first) */}
          <table className="vitals-table" style={{ margin: '0 auto' }}>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>SpO₂ (%)</th>
                <th>Pulse (BPM)</th>
              </tr>
            </thead>
            <tbody>
              {tableData.map((row, idx) => (
                <tr key={idx}>
                  <td>{new Date(row.timestamp * 1000).toLocaleTimeString()}</td>
                  <td>{row.spo2}</td>
                  <td>{row.pulse}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <SpO2Graph data={graphData} />
          <PulseGraph data={graphData} />
        </>
      )}
      <button onClick={() => navigate('/')}>Go Back Home</button>
    </div>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/data/:sessionKey" element={<DataPage />} />
    </Routes>
  );
}

export default App;
