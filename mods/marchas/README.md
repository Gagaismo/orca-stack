# Marchas

Marchas guarda cada cambio explícito de marcha asociado al ID de la sesión. Los registros de más de 30 días se eliminan la próxima vez que el mod inicia una sesión. La retención de 30 días se cuenta desde el comando `/marcha <marcha>` más reciente; una sesión retomada cuya clave haya vencido empieza en Medium.

Las versiones anteriores guardaban solo el nombre de la marcha, sin fecha. Esas entradas heredadas se conservan porque no se puede determinar su antigüedad con seguridad; Medium heredado se trata como si no se hubiera cambiado la marcha, porque las versiones anteriores también lo guardaban por defecto.

Después de una compactación, Marchas restaura la postura actual cuando se ejecuta `classic.SessionStart`. Si ese hook no está disponible, la banda recuerda que hay que repetir `/marcha <marcha>`.

Volver con rewind a un punto anterior al cambio de marcha puede quitar el mensaje de postura aunque el store del plugin y la banda sigan mostrando la marcha más nueva. Este comportamiento se informa en el issue #163 y las APIs de sesión actuales no lo reconcilian.

## Esfuerzo

Marchas ajusta el esfuerzo de cada solicitud de `main` sin cambiar el esfuerzo configurado para la sesión: Lazy pone un máximo de `medium`, Medium no lo reescribe y Proactive pone un mínimo de `xhigh`. Las solicitudes de subagentes quedan intactas. La respuesta visible de `/marcha` nombra el límite que aplica.

Un `/effort` manual gana hasta el siguiente cambio de marcha y pasa a ser la nueva base, incluso si la persona repite el mismo nivel. `/effort ultracode` es un cambio de flujo de trabajo, no un ajuste manual del esfuerzo. `/model` tampoco es un ajuste manual: Marchas vuelve a registrar la base observada para el nuevo modelo. La base y el ajuste manual se guardan junto con la marcha para que sigan vigentes al reanudar la sesión.

El nivel que se elige en el menú de `/effort` (y el resultado de `/effort auto`) no le llega al mod: Marchas solo ve el esfuerzo de cada solicitud. Por eso un esfuerzo que cambia cuenta como ajuste manual solo si se abrió el menú o se ejecutó `/effort auto` después del último `/marcha <marcha>`; si cambia sin un `/effort` desde ese cambio de marcha, no es manual y la marcha lo sigue ajustando. Elegir en el menú el mismo nivel que ya estaba no cuenta como ajuste manual, porque el mod no puede distinguirlo de cerrar el menú sin elegir. Queda un caso que el mod no puede distinguir: si elegís un nivel en el menú, cambiás de marcha y después abrís el menú y lo cancelás, el nivel que habías elegido antes se toma como ajuste manual.

## Modo autónomo

Marchas avisa en una línea cuando el modo autónomo coincide con algo que cambia lo que pasa sin supervisión. El aviso es una nota del transcript que el modelo no lee; si el transcript la rechaza, sale como toast.

- `/autonomo` en Lazy: los items que no estén especificados van a esperar un cambio de marcha.
- `/autonomo` en Proactive o con ultracode activo, o `/marcha proactive` o `/effort ultracode` con el modo autónomo ya activo: qué puede costar más sin supervisión (la exploración, las consultas y la vigilancia de Proactive; el workflow de ultracode para cada tarea sustantiva, sin límite de concurrencia) y cómo bajarlo (`/marcha medium`, o apagar ultracode).

Marchas lee el valor `isOn` de `modo-autonomo` y se entera de que el modo se encendió cuando ese mod lo escribe, sin depender del orden entre los dos mods. Sigue ultracode con `/effort ultracode` y con los attachments `ultra_effort_enter` y `ultra_effort_exit`: gana el último. Un attachment no avisa, porque al reanudar se vuelven a pedir los del historial. Ultracode dura un proceso, así que una sesión reanudada empieza sin ultracode. Después de `/clear` el mod no ve ultracode hasta el siguiente `/effort ultracode` o attachment, y el aviso de Proactive dice que no lo ve. En una organización que administra Claude Code los attachments no le llegan al mod, que entonces solo ve `/effort ultracode`.
