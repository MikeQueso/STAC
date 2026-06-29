// supabase/functions/stripe-webhook/index.ts
//
// Stripe llama a esta función cuando el pago se completa (o falla). Aquí
// marcamos el pedido como pagado y vaciamos el carrito del comprador.
// La firma del webhook se verifica con STRIPE_WEBHOOK_SECRET para asegurar
// que la llamada viene de verdad de Stripe (y no de cualquiera que conozca
// la URL).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@14.21.0";

serve(async (req) => {
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!stripeKey || !webhookSecret || !supabaseUrl || !serviceKey) {
    return new Response("Faltan variables de entorno en Supabase.", { status: 500 });
  }

  const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature || "", webhookSecret);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(`Firma inválida: ${msg}`, { status: 400 });
  }

  const sb = createClient(supabaseUrl, serviceKey);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as any;
    const orderId = session.metadata?.order_id;
    const userId = session.metadata?.user_id;
    if (orderId) {
      await sb.from("orders").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", orderId);
    }
    if (userId) {
      await sb.from("cart_items").delete().eq("user_id", userId);
    }
  } else if (event.type === "checkout.session.expired") {
    const session = event.data.object as any;
    const orderId = session.metadata?.order_id;
    if (orderId) await sb.from("orders").update({ status: "canceled" }).eq("id", orderId);
  }

  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
