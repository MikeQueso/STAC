import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@14.21.0";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

serve(async (req) => {
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const gmailUser = Deno.env.get("GMAIL_USER");
  const gmailPassword = Deno.env.get("GMAIL_APP_PASSWORD");

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

    // Enviar email de confirmación vía Gmail SMTP si está configurado
    console.log("[email] gmailUser configurado:", !!gmailUser, "gmailPassword configurado:", !!gmailPassword, "orderId:", orderId, "userId:", userId);
    if (gmailUser && gmailPassword && orderId && userId) {
      try {
        // Obtener datos del usuario
        const { data: userData, error: userErr } = await sb.auth.admin.getUserById(userId);
        if (userErr) console.error("[email] Error obteniendo usuario:", userErr.message);
        const email = userData?.user?.email;
        console.log("[email] Correo destino resuelto:", email || "(ninguno)");
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
              <tr style="background:#ffffff;">
                <td style="padding:10px 12px; border-bottom:1px solid #dde4f0; color:#111; font-size:13.5px;">${it.name}</td>
                <td style="padding:10px 12px; border-bottom:1px solid #dde4f0; text-align:center; color:#555;">${it.quantity}</td>
                <td style="padding:10px 12px; border-bottom:1px solid #dde4f0; text-align:right; color:#555;">$${Number(it.price).toLocaleString("es-MX")}</td>
                <td style="padding:10px 12px; border-bottom:1px solid #dde4f0; text-align:right; color:#1a5cb0; font-weight:700;">$${(it.price * it.quantity).toLocaleString("es-MX", { maximumFractionDigits: 0 })}</td>
              </tr>`).join("");

            const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#040d1a;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px;">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#0a1a3a,#1a0a0a);border-radius:12px 12px 0 0;padding:28px 32px;text-align:center;border-bottom:3px solid #cc1f1f;">
      <img src="https://mikequeso.github.io/STAC/favicon.png" alt="STAC" style="width:72px;height:72px;margin-bottom:10px;display:block;margin-left:auto;margin-right:auto;">
      <h1 style="margin:0;color:#ffffff;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">SOPORTE TÉCNICO AVANZADO EN COMPUTACIÓN</h1>
      <div style="margin:14px auto 0;background:linear-gradient(135deg,#cc1f1f,#1a5cb0);border-radius:8px;padding:12px 24px;display:inline-block;">
        <span style="color:#ffffff;font-size:20px;font-weight:700;">✅ ¡Pago confirmado!</span>
      </div>
      <p style="margin:10px 0 0;color:#aac4e8;font-size:13.5px;">Gracias por tu compra en <strong style="color:#ffffff;">STAC</strong></p>
    </div>

    <!-- Body -->
    <div style="background:#ffffff;padding:28px 32px;border:1px solid #dde4f0;border-top:none;">
      <p style="color:#555;font-size:13.5px;margin:0 0 20px;">Fecha: <strong style="color:#111;">${fecha}</strong> &nbsp;|&nbsp; Pedido: <span style="color:#1a5cb0;font-family:monospace;font-size:12px;">${orderId}</span></p>

      <!-- Tabla de productos -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <thead>
          <tr style="background:#1a0a0a;">
            <th style="padding:10px 12px;text-align:left;color:#ffffff;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Producto</th>
            <th style="padding:10px 12px;text-align:center;color:#ffffff;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Cant.</th>
            <th style="padding:10px 12px;text-align:right;color:#ffffff;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Precio unit.</th>
            <th style="padding:10px 12px;text-align:right;color:#ffffff;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Importe</th>
          </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
      </table>

      <!-- Desglose fiscal -->
      <div style="background:#f4f7fc;border:1px solid #dde4f0;border-left:4px solid #1a5cb0;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:5px 0;color:#555;font-size:13.5px;">Subtotal (sin IVA)</td>
            <td style="padding:5px 0;text-align:right;color:#111;font-size:13.5px;">$${subtotal.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>
          <tr>
            <td style="padding:5px 0;color:#555;font-size:13.5px;">IVA (16%)</td>
            <td style="padding:5px 0;text-align:right;color:#111;font-size:13.5px;">$${iva.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>
          <tr style="border-top:2px solid #dde4f0;">
            <td style="padding:12px 0 5px;color:#111;font-size:16px;font-weight:700;">Total pagado</td>
            <td style="padding:12px 0 5px;text-align:right;color:#cc1f1f;font-size:18px;font-weight:700;">$${Number(order.total).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MXN</td>
          </tr>
        </table>
      </div>

      <p style="color:#888;font-size:12px;text-align:center;margin:0;line-height:1.7;">
        Los precios incluyen IVA (16%) conforme a la Ley del Impuesto al Valor Agregado vigente en México.<br>
        Este comprobante no es una factura fiscal (CFDI). Para solicitar factura contáctanos.
      </p>
    </div>

    <!-- Footer -->
    <div style="background:linear-gradient(135deg,#1a0a0a,#0a1a3a);border-radius:0 0 12px 12px;padding:20px 32px;text-align:center;">
      <p style="color:#aac4e8;font-size:12px;margin:0;">
        <strong style="color:#ffffff;">STAC</strong> – Soporte Técnico Avanzado en Computación<br>
        <a href="https://mikequeso.github.io/STAC" style="color:#cc1f1f;text-decoration:none;">mikequeso.github.io/STAC</a>
      </p>
    </div>

  </div>
</body>
</html>`;

            console.log("[email] Conectando a smtp.gmail.com:465...");
            const client = new SMTPClient({
              connection: {
                hostname: "smtp.gmail.com",
                port: 465,
                tls: true,
                auth: { username: gmailUser, password: gmailPassword },
              },
            });

            console.log("[email] Conectado. Enviando mensaje a", email, "...");
            await client.send({
              from: `STAC <${gmailUser}>`,
              to: email,
              subject: "✅ Tu compra en STAC fue confirmada",
              html,
            });

            await client.close();
            console.log("[email] Enviado correctamente a", email);
          } else {
            console.error("[email] No se pudo enviar: items o order vacíos.", { items, order });
          }
        }
      } catch (emailErr) {
        // El email falló pero el pago ya está registrado — no retornamos error
        const msg = emailErr instanceof Error ? `${emailErr.name}: ${emailErr.message}\n${emailErr.stack}` : JSON.stringify(emailErr);
        console.error("[email] Error enviando email:", msg);
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
