# Cloud Binding — Self-Hosted Deployment

The Rotifer Cloud Binding backend uses [Supabase](https://supabase.com) (PostgreSQL + Auth + Storage + Realtime).

## Using the Official Cloud

No setup needed — the CLI connects to the official endpoint by default.

## Self-Hosting

To run your own Cloud Binding instance:

1. Create a Supabase project at <https://supabase.com>
2. Apply the database schema (see the [Cloud Binding API docs](../docs/cloud-binding-api.md) for table structures)
3. Configure your CLI:

```bash
export ROTIFER_CLOUD_ENDPOINT="https://your-project.supabase.co"
export ROTIFER_CLOUD_ANON_KEY="your-anon-key"
```

Or create `~/.rotifer/cloud.json`:

```json
{
  "endpoint": "https://your-project.supabase.co",
  "anonKey": "your-anon-key"
}
```

4. Run `rotifer login` to authenticate via GitHub OAuth

## Database Schema

The required tables, RLS policies, and functions are documented in the
[Cloud Binding API specification](../docs/cloud-binding-api.md).
Migration files are not included in this repository.
