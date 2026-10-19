// Public settings for the Supabase project. The anon key is designed to be public:
// row level security (supabase/schema.sql) makes every row readable and writable only by its owner.
// Leave both empty to run the app in demo mode with sample data.
window.APP_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
};
