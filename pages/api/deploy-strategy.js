// pages/api/deploy-strategy.js
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { strategy, version, config } = req.body;

  if (!strategy || !version || !config) {
    return res.status(400).json({ error: 'Missing strategy, version, or config' });
  }

  try {
    // Step 1: Deactivate any active strategy
    await supabase.from('active_strategy').update({ active: false }).eq('active', true)

    // Step 2: Insert the new one
    const { error } = await supabase.from('active_strategy').insert([
      {
        strategy,
        version,
        config,
        promoted_at: new Date().toISOString(),
        active: true
      }
    ])

    if (error) throw error

    return res.status(200).json({ message: '✅ Strategy promoted' })
  } catch (err) {
    console.error('❌ Promotion Error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
