## Build Images

```bash
./dockerfiles/build.sh
```

Images:

- `local-ubuntu-bash` / `local-alpine-bash` / `local-ubuntu-fish` / `local-ubuntu-noflock` — general fixture hosts
- `local-ubuntu-mfa` — keyboard-interactive-only target with an independent auth counter (`/var/run/ssh-auth-count` and sshd `Accepted` logs) for issue #206 sharing e2e

### Debugging Image

### Run Image in Interactive Mode

```bash
docker run -it --rm --name open-remote-ssh-test --publish 2222:2222 --env USER_NAME=openremotessh --env USER_PASSWORD=openremotessh --env PASSWORD_ACCESS=true --env SUDO_ACCESS=false --env LOG_STDOUT=true local-ubuntu-bash bash
```

### Test Setup Script

```
/usr/local/bin/start-sshd.sh
```

### Delete Container

```
docker rm -f open-remote-ssh-test
```
