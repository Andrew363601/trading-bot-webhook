// /pages/api/get-active-strategy.js

import { createClient } from '@supabase/supabase-js';


const supabase = createClient(

process.env.NEXT_PUBLIC_SUPABASE_URL,

process.env.SUPABASE_SERVICE_ROLE_KEY

);


export default async function handler(req, res) {

const { data, error } = await supabase

.from('strategy_config') // Changed from 'active_strategy' to 'strategy_config'

.select('*')

.eq('is_active', true)

.single();


if (error) {

if (error.code === 'PGRST116') { // No rows found for .single()

return res.status(200).json(null); // Return null or empty object if no active strategy

}

console.error('Supabase error fetching active strategy:', error.message);

return res.status(500).json({ error: error.message });

}


res.status(200).json(data);

}


