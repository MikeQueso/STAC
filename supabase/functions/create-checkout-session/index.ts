// supabase/functions/create-checkout-session/index.ts
//
// Crea una sesión de pago de Stripe Checkout a partir del carrito del
// usuario autenticado. El precio SIEMPRE se vuelve a leer de la tabla
// `products` en el servidor (nunca se confía en lo que mande el navegador),
// para que nadie pueda manipular el precio desde el cliente.
//
// Uso desde el sitio (POST, con el JWT del usuario en Authorization):
//   body: {} (lee el carrito del usuario directamente de cart_items)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@14.21.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const siteUrl = Deno.env.get("SITE_URL") || "https://mikequeso.github.io/STAC";
    if (!stripeKey || !supabaseUrl || !serviceKey) {
      return new Response(JSON.stringify({ error: "Faltan variables de entorno en Supabase." }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "No autenticado." }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Cliente con la service role (para leer cart_items/products sin RLS),
    // pero primero verificamos quién es el usuario a partir de su JWT.
    const sbAuth = createClient(supabaseUrl, serviceKey);
    const { data: userData, error: userErr } = await sbAuth.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Sesión inválida." }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const { data: cart, error: cartErr } = await sbAuth
      .from("cart_items")
      .select("quantity, products(id, name, price, images)")
      .eq("user_id", userId);
    if (cartErr) {
      return new Response(JSON.stringify({ error: cartErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!cart || !cart.length) {
      return new Response(JSON.stringify({ error: "El carrito está vacío." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const lineItems = [];
    const orderItemsDraft = [];
    let total = 0;
    for (const it of cart) {
      const p = it.products as any;
      if (!p) continue;
      const price = Number(p.price);
      const qty = Number(it.quantity);
      total += price * qty;
      // Enviamos el precio sin IVA a Stripe y agregamos IVA como línea separada
      const priceExIva = Math.round((price / 1.16) * 100); // centavos sin IVA
      lineItems.push({
        price_data: {
          currency: "mxn",
          product_data: {
            name: p.name,
            images: p.images && p.images.length ? [p.images[0]] : undefined,
          },
          unit_amount: priceExIva,
        },
        quantity: qty,
      });
      orderItemsDraft.push({ product_id: p.id, name: p.name, price, quantity: qty });
    }
    // Línea de IVA (16% sobre el subtotal sin IVA = total - total/1.16)
    const ivaAmount = Math.round(total * 100) - lineItems.reduce((s, l) => s + l.price_data.unit_amount * l.quantity, 0);
    lineItems.push({
      price_data: {
        currency: "mxn",
        product_data: { name: "IVA (16%)" },
        unit_amount: ivaAmount,
      },
      quantity: 1,
    });
    if (!lineItems.length) {
      return new Response(JSON.stringify({ error: "El carrito está vacío." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Crea el pedido en estado "pending" ANTES de ir a Stripe.
    const { data: order, error: orderErr } = await sbAuth
      .from("orders")
      .insert({ user_id: userId, status: "pending", total, currency: "mxn" })
      .select()
      .single();
    if (orderErr || !order) {
      return new Response(JSON.stringify({ error: orderErr?.message || "No se pudo crear el pedido." }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    await sbAuth.from("order_items").insert(
      orderItemsDraft.map((it) => ({ ...it, order_id: order.id }))
    );

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: lineItems,
      success_url: `${siteUrl}/#pago-exitoso`,
      cancel_url: `${siteUrl}/#pago-cancelado`,
      metadata: { order_id: order.id, user_id: userId },
      shipping_address_collection: { allowed_countries: ["MX"] },
    });

    await sbAuth.from("orders").update({ stripe_session_id: session.id }).eq("id", order.id);

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
