// supabase/functions/password-reset/index.ts
//
// Recuperación de contraseña con código temporal enviado por correo (Gmail SMTP).
// Dos acciones, ambas vía POST con { action: "request" | "confirm", ... }:
//   request: { username, email } -> genera un código de 6 dígitos, lo guarda
//            en password_resets (expira en 15 min) y lo envía por correo.
//   confirm: { username, code, newPassword } -> valida el código y actualiza
//            la contraseña del usuario con la service role.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const gmailUser = Deno.env.get("GMAIL_USER");
    const gmailPassword = Deno.env.get("GMAIL_APP_PASSWORD");

    if (!supabaseUrl || !serviceKey) {
      return jsonResponse({ error: "Faltan variables de entorno en Supabase." }, 500);
    }

    const sb = createClient(supabaseUrl, serviceKey);
    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === "request") {
      const username = String(body.username || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      if (!username || !email) {
        return jsonResponse({ error: "Faltan datos." }, 400);
      }
      if (!gmailUser || !gmailPassword) {
        return jsonResponse({ error: "El envío de correo no está configurado." }, 500);
      }

      const { data: profile } = await sb
        .from("profiles")
        .select("id, username, email")
        .ilike("username", username)
        .maybeSingle();

      if (!profile || String(profile.email || "").toLowerCase() !== email) {
        return jsonResponse({ error: "El usuario y el correo no coinciden con ningún registro." }, 404);
      }

      const code = generateCode();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      // Invalida códigos anteriores sin usar de este usuario.
      await sb.from("password_resets").update({ used: true }).eq("user_id", profile.id).eq("used", false);

      const { error: insertErr } = await sb.from("password_resets").insert({
        user_id: profile.id,
        code,
        expires_at: expiresAt,
      });
      if (insertErr) {
        console.error("[password-reset] Error guardando código:", insertErr.message);
        return jsonResponse({ error: "No se pudo generar el código. Intenta de nuevo." }, 500);
      }

      const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#040d1a;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px;">
    <div style="background:linear-gradient(135deg,#0a1a3a,#1a0a0a);border-radius:12px 12px 0 0;padding:28px 32px;text-align:center;border-bottom:3px solid #cc1f1f;">
      <img src="https://mikequeso.github.io/STAC/favicon.png" alt="STAC" style="width:64px;height:64px;margin-bottom:8px;display:block;margin-left:auto;margin-right:auto;">
      <h1 style="margin:0;color:#ffffff;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">SOPORTE TÉCNICO AVANZADO EN COMPUTACIÓN</h1>
    </div>
    <div style="background:#ffffff;padding:32px;border:1px solid #dde4f0;border-top:none;border-radius:0 0 12px 12px;text-align:center;">
      <p style="color:#333;font-size:14.5px;margin:0 0 18px;">Hola <strong>${username}</strong>, usa este código para restablecer tu contraseña en STAC:</p>
      <div style="display:inline-block;background:#f4f7fc;border:1px solid #dde4f0;border-radius:10px;padding:16px 32px;margin-bottom:18px;">
        <span style="font-family:monospace;font-size:32px;font-weight:700;letter-spacing:6px;color:#1a5cb0;">${code}</span>
      </div>
      <p style="color:#888;font-size:12.5px;margin:0;">Este código expira en 15 minutos. Si no solicitaste este cambio, ignora este correo.</p>
    </div>
  </div>
</body>
</html>`;

      const text = `Hola ${username}, usa este código para restablecer tu contraseña en STAC: ${code}\n\nEste código expira en 15 minutos. Si no solicitaste este cambio, ignora este correo.`;

      try {
        const client = new SMTPClient({
          connection: {
            hostname: "smtp.gmail.com",
            port: 465,
            tls: true,
            auth: { username: gmailUser, password: gmailPassword },
          },
        });
        await client.send({
          from: `STAC <${gmailUser}>`,
          to: email,
          replyTo: gmailUser,
          subject: "Tu código para restablecer tu contraseña en STAC",
          content: text,
          html,
        });
        await client.close();
      } catch (emailErr) {
        const msg = emailErr instanceof Error ? emailErr.message : String(emailErr);
        console.error("[password-reset] Error enviando email:", msg);
        return jsonResponse({ error: "No se pudo enviar el correo. Intenta de nuevo más tarde." }, 500);
      }

      return jsonResponse({ ok: true });
    }

    if (action === "confirm") {
      const username = String(body.username || "").trim();
      const code = String(body.code || "").trim();
      const newPassword = String(body.newPassword || "");

      if (!username || !code || newPassword.length < 6) {
        return jsonResponse({ error: "Datos inválidos. La contraseña debe tener al menos 6 caracteres." }, 400);
      }

      const { data: profile } = await sb
        .from("profiles")
        .select("id")
        .ilike("username", username)
        .maybeSingle();

      if (!profile) {
        return jsonResponse({ error: "Código inválido o expirado." }, 404);
      }

      const { data: reset } = await sb
        .from("password_resets")
        .select("id, expires_at, used")
        .eq("user_id", profile.id)
        .eq("code", code)
        .eq("used", false)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!reset || new Date(reset.expires_at).getTime() < Date.now()) {
        return jsonResponse({ error: "Código inválido o expirado." }, 404);
      }

      const { error: updateErr } = await sb.auth.admin.updateUserById(profile.id, { password: newPassword });
      if (updateErr) {
        console.error("[password-reset] Error actualizando contraseña:", updateErr.message);
        return jsonResponse({ error: "No se pudo actualizar la contraseña." }, 500);
      }

      await sb.from("password_resets").update({ used: true }).eq("id", reset.id);

      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Acción no reconocida." }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse({ error: msg }, 500);
  }
});
