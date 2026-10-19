#!/bin/zsh
# Saves the Supabase secret key on this Mac only (~/.config/semester-catchup/supabase.local.json, readable by you alone).
# The key is typed hidden and never printed.
set -e
URL="https://sllgfikkciikzzpccnyh.supabase.co"
mkdir -p ~/.config/semester-catchup
echo "Paste the Supabase secret (service_role) key and press Enter. It won't show while you paste."
read -rs "KEY?Secret key: "
echo
read -r "EMAIL?Email you'll sign in to the app with: "
umask 077
printf '{"url":"%s","service_key":"%s","email":"%s"}\n' "$URL" "$KEY" "$EMAIL" > ~/.config/semester-catchup/supabase.local.json
chmod 600 ~/.config/semester-catchup/supabase.local.json
echo "Saved. You can close this tab."
