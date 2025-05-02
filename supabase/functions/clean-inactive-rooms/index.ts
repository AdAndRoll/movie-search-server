import { serve } from 'https://deno.land/std/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js'

serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const { error } = await supabase.rpc('clean_inactive_rooms')
  if (error) {
    console.error('Error cleaning rooms:', error)
    return new Response('Failed', { status: 500 })
  }

  return new Response('Success', { status: 200 })
})
