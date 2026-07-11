// VORTEXIA — Supabase client config
// Same Supabase project as before (SMM Hub), now rebuilt for VORTEXIA.
const SUPABASE_URL = "https://rgoasqesstmwfuqzhmqp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJnb2FzcWVzc3Rtd2Z1cXpobXFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2ODM4NTgsImV4cCI6MjA5ODI1OTg1OH0.2N_dNDdTo9sbYsuX_FAMRWZZ3jiNA2gnF13FhicdRR0";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
