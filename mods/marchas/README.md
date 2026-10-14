# Marchas

Marchas guarda cada cambio explícito de marcha asociado al ID de la sesión. Los registros de más de 30 días se eliminan la próxima vez que el mod inicia una sesión. La retención de 30 días se cuenta desde el comando `/marcha <marcha>` más reciente; una sesión retomada cuya clave haya vencido empieza en Medium.

Las versiones anteriores guardaban solo el nombre de la marcha, sin fecha. Esas entradas heredadas se conservan porque no se puede determinar su antigüedad con seguridad; Medium heredado se trata como si no se hubiera cambiado la marcha, porque las versiones anteriores también lo guardaban por defecto.

Después de una compactación, Marchas restaura la postura actual cuando se ejecuta `classic.SessionStart`. Si ese hook no está disponible, la banda recuerda que hay que repetir `/marcha <marcha>`.

Volver con rewind a un punto anterior al cambio de marcha puede quitar el mensaje de postura aunque el store del plugin y la banda sigan mostrando la marcha más nueva. Este comportamiento se informa en el issue #163 y las APIs de sesión actuales no lo reconcilian.
