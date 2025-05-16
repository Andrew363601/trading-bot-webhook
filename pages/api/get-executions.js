// /pages/api/get-executions.js
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  const { data, error } = await supabase
    .from('executions')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(20)

  if (error) return res.status(500).json({ error })
  res.status(200).json(data)
}
