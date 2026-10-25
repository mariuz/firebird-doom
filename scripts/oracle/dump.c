// dump.c – the .lmp oracle's per-tic trace (MIT, like the rest of Firebird DOOM but
// src/states.js). Linked into an unmodified Chocolate Doom with -Wl,--wrap=G_Ticker
// (scripts/oracle/build.sh): after each real G_Ticker in a level, one line of the game's
// state goes to the file $ORACLE_TRACE. It only reads the game's globals.
//
//   leveltime prndindex  the console player's mobj: x y z angle momx momy  its health
//   then over every mobj (P_MobjThinker): count, and the sums of x, y, z, health, statenum
//
// Positions are 16.16 fixed point and the angle a BAM, as DOOM keeps them; the sums don't
// depend on the thinker list's order.
#include <stdio.h>
#include <stdlib.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"
#include "info.h"
#include "p_local.h"

extern int prndindex;
void __real_G_Ticker(void);

static FILE *out;

void __wrap_G_Ticker(void)
{
    thinker_t *th;
    long long n = 0, sx = 0, sy = 0, sz = 0, shp = 0, sst = 0;
    player_t *pl;
    mobj_t *mo;

    __real_G_Ticker();
    if (gamestate != GS_LEVEL) return;
    if (!out)
    {
        const char *path = getenv("ORACLE_TRACE");
        if (!path || !(out = fopen(path, "w"))) return;
    }
    pl = &players[consoleplayer];
    mo = pl->mo;
    if (!mo) return;
    for (th = thinkercap.next; th != &thinkercap; th = th->next)
    {
        mobj_t *m;
        if (th->function.acp1 != (actionf_p1) P_MobjThinker) continue;
        m = (mobj_t *) th;
        n++;
        sx += m->x;
        sy += m->y;
        sz += m->z;
        shp += m->health;
        sst += m->state ? (long long) (m->state - states) : 0;
    }
    fprintf(out, "%d %d %d %d %d %u %d %d %d %lld %lld %lld %lld %lld %lld\n",
            leveltime, prndindex, mo->x, mo->y, mo->z, (unsigned) mo->angle, mo->momx, mo->momy,
            pl->health, n, sx, sy, sz, shp, sst);
    fflush(out);
}
