import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@14.21.0";

serve(async (req) => {
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");

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

    // Enviar email de confirmación si Resend está configurado
    if (resendKey && orderId && userId) {
      try {
        // Obtener datos del usuario
        const { data: userData } = await sb.auth.admin.getUserById(userId);
        const email = userData?.user?.email;
        if (email) {
          // Obtener items del pedido
          const { data: items } = await sb
            .from("order_items")
            .select("name, price, quantity")
            .eq("order_id", orderId);

          const { data: order } = await sb
            .from("orders")
            .select("total, created_at")
            .eq("id", orderId)
            .single();

          if (items && order) {
            const subtotal = order.total / 1.16;
            const iva = order.total - subtotal;
            const fecha = new Date(order.created_at).toLocaleDateString("es-MX", {
              year: "numeric", month: "long", day: "numeric",
            });

            const itemsHtml = items.map((it: any) => `
              <tr>
                <td style="padding:10px 12px; border-bottom:1px solid #1a3a6b; color:#e8f1ff; font-size:14px;">${it.name}</td>
                <td style="padding:10px 12px; border-bottom:1px solid #1a3a6b; text-align:center; color:#9db8d8;">${it.quantity}</td>
                <td style="padding:10px 12px; border-bottom:1px solid #1a3a6b; text-align:right; color:#9db8d8;">$${Number(it.price).toLocaleString("es-MX")}</td>
                <td style="padding:10px 12px; border-bottom:1px solid #1a3a6b; text-align:right; color:#00aaff; font-weight:600;">$${(it.price * it.quantity).toLocaleString("es-MX", { maximumFractionDigits: 0 })}</td>
              </tr>`).join("");

            const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#040d1a;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px;">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#003820,#005030);border-radius:12px 12px 0 0;padding:28px 32px;text-align:center;">
      <div style="font-size:36px;margin-bottom:8px;">✅</div>
      <h1 style="margin:0;color:#00e5b0;font-size:22px;font-weight:700;">¡Pago confirmado!</h1>
      <p style="margin:6px 0 0;color:#9db8d8;font-size:14px;">Gracias por tu compra en <strong style="color:#e8f1ff;">STAC</strong></p>
    </div>

    <!-- Body -->
    <div style="background:#071528;padding:28px 32px;border:1px solid rgba(0,95,255,0.18);border-top:none;">
      <p style="color:#9db8d8;font-size:13.5px;margin:0 0 20px;">Fecha: <strong style="color:#e8f1ff;">${fecha}</strong> &nbsp;|&nbsp; Pedido: <span style="color:#1e90ff;font-family:monospace;font-size:12px;">${orderId}</span></p>

      <!-- Tabla de productos -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <thead>
          <tr style="background:#0c1e3a;">
            <th style="padding:10px 12px;text-align:left;color:#9db8d8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Producto</th>
            <th style="padding:10px 12px;text-align:center;color:#9db8d8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Cant.</th>
            <th style="padding:10px 12px;text-align:right;color:#9db8d8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Precio unit.</th>
            <th style="padding:10px 12px;text-align:right;color:#9db8d8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Importe</th>
          </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
      </table>

      <!-- Desglose fiscal -->
      <div style="background:#0c1e3a;border:1px solid rgba(0,95,255,0.25);border-radius:10px;padding:16px 20px;margin-bottom:24px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
          <span style="color:#9db8d8;font-size:13.5px;">Subtotal (sin IVA)</span>
          <span style="color:#e8f1ff;font-size:13.5px;">$${subtotal.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
          <span style="color:#9db8d8;font-size:13.5px;">IVA (16%)</span>
          <span style="color:#e8f1ff;font-size:13.5px;">$${iva.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding-top:12px;border-top:1px solid rgba(0,95,255,0.2);">
          <span style="color:#e8f1ff;font-size:16px;font-weight:700;">Total pagado</span>
          <span style="color:#00e5b0;font-size:18px;font-weight:700;">$${Number(order.total).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MXN</span>
        </div>
      </div>

      <p style="color:#4a6a90;font-size:12px;text-align:center;margin:0;">
        Los precios incluyen IVA (16%) conforme a la Ley del Impuesto al Valor Agregado vigente en México.<br>
        Este comprobante no es una factura fiscal (CFDI). Para solicitar factura contáctanos.
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#040d1a;border:1px solid rgba(0,95,255,0.18);border-top:none;border-radius:0 0 12px 12px;padding:20px 32px;text-align:center;">
      <p style="color:#4a6a90;font-size:12px;margin:0;">
        STAC – Componentes para PC &nbsp;|&nbsp; <a href="https://mikequeso.github.io/STAC" style="color:#1e90ff;">mikequeso.github.io/STAC</a>
      </p>
    </div>

  </div>
</body>
</html>`;

            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${resendKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from: "STAC <onboarding@resend.dev>",
                to: [email],
                subject: "✅ Tu compra en STAC fue confirmada",
                html,
              }),
            });
          }
        }
      } catch (emailErr) {
        // El email falló pero el pago ya está registrado — no retornamos error
        console.error("Error enviando email:", emailErr);
      }
    }

  } else if (event.type === "checkout.session.expired") {
    const session = event.data.object as any;
    const orderId = session.metadata?.order_id;
    if (orderId) await sb.from("orders").update({ status: "canceled" }).eq("id", orderId);
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
