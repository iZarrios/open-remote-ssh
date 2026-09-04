#!/usr/bin/env bash
set -e

mkdir -p /config/{.ssh,logs/openssh,sshd}
mkdir -p /run/sshd

USER_NAME=${USER_NAME:-linuxserver.io}
USER_PASSWORD=${USER_PASSWORD:-$(< /dev/urandom tr -dc _A-Z-a-z-0-9 | head -c"${1:-8}";echo;)}

useradd -m -s /bin/bash "${USER_NAME}"
echo "${USER_NAME}:${USER_PASSWORD}" | chpasswd
usermod -aG sudo "${USER_NAME}"

if [[ ! -f /config/sshd/sshd_config ]]; then
    sed -i '/#PidFile/c\PidFile \/config\/sshd.pid' /etc/ssh/sshd_config
    sed -i 's/Include \/etc\/ssh\/sshd_config.d\/\*.conf/#Include \/etc\/ssh\/sshd_config.d\/\*.conf/' /etc/ssh/sshd_config
    cp -a /etc/ssh/sshd_config /config/sshd/sshd_config
fi

if [[ ! -d /config/ssh_host_keys ]]; then
    mkdir -p /config/ssh_host_keys
    ssh-keygen -A
    cp /etc/ssh/ssh_host_* /config/ssh_host_keys
fi

# custom port
if [[ -n "${LISTEN_PORT}" ]]; then
    sed -i "s/^#Port [[:digit:]]\+/Port ${LISTEN_PORT}"/ /config/sshd/sshd_config
    sed -i "s/^Port [[:digit:]]\+/Port ${LISTEN_PORT}"/ /config/sshd/sshd_config
else
    sed -i "s/^#Port [[:digit:]]\+/Port 2222"/ /config/sshd/sshd_config
    sed -i "s/^Port [[:digit:]]\+/Port 2222"/ /config/sshd/sshd_config
fi

# Keyboard-interactive MFA-style auth only (password prompt via PAM).
sed -i '/^#PasswordAuthentication/c\PasswordAuthentication no' /config/sshd/sshd_config
sed -i '/^PasswordAuthentication/c\PasswordAuthentication no' /config/sshd/sshd_config
sed -i '/^#KbdInteractiveAuthentication/c\KbdInteractiveAuthentication yes' /config/sshd/sshd_config
sed -i '/^KbdInteractiveAuthentication/c\KbdInteractiveAuthentication yes' /config/sshd/sshd_config
sed -i '/^#ChallengeResponseAuthentication/c\ChallengeResponseAuthentication yes' /config/sshd/sshd_config
sed -i '/^ChallengeResponseAuthentication/c\ChallengeResponseAuthentication yes' /config/sshd/sshd_config
if ! grep -q '^AuthenticationMethods' /config/sshd/sshd_config; then
    echo 'AuthenticationMethods keyboard-interactive' >> /config/sshd/sshd_config
else
    sed -i '/^AuthenticationMethods/c\AuthenticationMethods keyboard-interactive' /config/sshd/sshd_config
fi

# Independent successful-login counter via PAM session (once per SSH connection).
cat > /etc/pam.d/sshd <<'EOF'
# PAM configuration for the Secure Shell service used by open-remote-ssh e2e.
@include common-auth
@include common-account
@include common-session
session optional pam_exec.so /usr/local/bin/count-ssh-auth.sh
@include common-password
EOF
echo 0 > /var/run/ssh-auth-count
chmod 644 /var/run/ssh-auth-count

if [[ ! -f /config/.ssh/authorized_keys ]]; then
    touch /config/.ssh/authorized_keys
fi

chown -R "${USER_NAME}":"${USER_NAME}" /config
chmod go-w /config
chmod 700 /config/.ssh
chmod 600 /config/.ssh/authorized_keys
chown -R root:"${USER_NAME}" /config/sshd
chmod 750 /config/sshd
chmod 640 /config/sshd/sshd_config

exec /usr/sbin/sshd -D -e -f /config/sshd/sshd_config
