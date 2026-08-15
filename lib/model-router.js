// lib/model-router.js

/**
 * Reads the singleton AI configuration from app_config (id = 1).
 * Returns the active provider ('gemini' | 'openrouter'), the model string,
 * and the appropriate API key from environment variables.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<{ provider: 'gemini' | 'openrouter', model: string, apiKey: string }>}
 */
export async function getActiveModel(supabase) {
  try {
    const { data } = await supabase
      .from('app_config')
      .select('ai_provider, ai_model')
      .eq('id', 1)
      .maybeSingle();

    const provider = data?.ai_provider === 'openrouter' ? 'openrouter' : 'gemini';
    const model = data?.ai_model || (provider === 'openrouter' ? 'openai/gpt-4o' : 'gemini-3-flash-preview');

    if (provider === 'openrouter') {
      return {
        provider: 'openrouter',
        model,
        apiKey: process.env.OPENROUTER_API_KEY || ''
      };
    }

    return {
      provider: 'gemini',
      model,
      apiKey: process.env.GEMINI_API_KEY || ''
    };
  } catch (err) {
    console.error('[MODEL ROUTER] Error fetching active model config:', err.message);
    return {
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      apiKey: process.env.GEMINI_API_KEY || ''
    };
  }
}
