// dump.c – the .lmp oracle's per-tic trace (MIT, like the rest of Firebird DOOM but
// src/states.js). Linked into an unmodified Chocolate Doom with -Wl,--wrap=G_Ticker and
// -Wl,--wrap=P_SetupLevel (scripts/oracle/build.sh): when a level has been set up (leveltime
// 0), and after each real G_Ticker in a level, one line of the game's state goes to the file
// $ORACLE_TRACE. It only reads the game's globals.
//
//   leveltime prndindex  the console player's mobj: x y z angle momx momy  its health
//   then over every mobj (P_MobjThinker): count, and the sums of x, y, z, health, statenum
//
// Positions are 16.16 fixed point and the angle a BAM, as DOOM keeps them; the sums don't
// depend on the thinker list's order.
//
// With $ORACLE_MOBJS, every thinker too, in the list's order (P_RunThinkers'), at the level's
// setup ($ORACLE_MOBJS_TICS: "all", or the leveltimes to write, as "0,35,70"; 0 alone by
// default): a mobj as
//   leveltime k M type  spawnpoint x y type options  x y z angle momx momy momz health
//   statenum tics flags floorz ceilingz reactiontime movedir movecount threshold lastlook
// and any other thinker as  leveltime k T name  (T_LightFlash, T_StrobeFlash, …).
//
// With $ORACLE_SECTORS, each sector whose floor, ceiling, light or special changed since the last
// tic (all of them at the setup), as  leveltime sector floorheight ceilingheight lightlevel special.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"
#include "info.h"
#include "p_local.h"
#include "p_spec.h"

extern int prndindex;
void __real_G_Ticker(void);
void __real_P_SetupLevel(int episode, int map, int playermask, skill_t skill);

static FILE *out;
static FILE *mobjs;

static int want_tic(int t)
{
    const char *tics = getenv("ORACLE_MOBJS_TICS");
    const char *p;
    if (!tics) return t == 0;
    if (!strcmp(tics, "all")) return 1;
    for (p = tics; *p; )
    {
        if (atoi(p) == t) return 1;
        while (*p && *p != ',') p++;
        if (*p == ',') p++;
    }
    return 0;
}

void T_FireFlicker(fireflicker_t *flick);   // (p_lights.c's, not in p_spec.h)

static const char *thinker_name(thinker_t *th)
{
    actionf_p1 f = th->function.acp1;
    if (f == (actionf_p1) T_LightFlash) return "T_LightFlash";
    if (f == (actionf_p1) T_StrobeFlash) return "T_StrobeFlash";
    if (f == (actionf_p1) T_Glow) return "T_Glow";
    if (f == (actionf_p1) T_FireFlicker) return "T_FireFlicker";
    if (f == (actionf_p1) T_VerticalDoor) return "T_VerticalDoor";
    if (f == (actionf_p1) T_PlatRaise) return "T_PlatRaise";
    if (f == (actionf_p1) T_MoveCeiling) return "T_MoveCeiling";
    if (f == (actionf_p1) T_MoveFloor) return "T_MoveFloor";
    if (th->function.acv == (actionf_v) (-1)) return "removed";
    return "other";
}

static void dump_mobjs(void)
{
    thinker_t *th;
    int k = 0;
    if (!mobjs)
    {
        const char *path = getenv("ORACLE_MOBJS");
        if (!path || !(mobjs = fopen(path, "w"))) return;
    }
    if (!want_tic(leveltime)) return;
    for (th = thinkercap.next; th != &thinkercap; th = th->next, k++)
    {
        mobj_t *m;
        if (th->function.acp1 != (actionf_p1) P_MobjThinker)
        {
            fprintf(mobjs, "%d %d T %s\n", leveltime, k, thinker_name(th));
            continue;
        }
        m = (mobj_t *) th;
        fprintf(mobjs, "%d %d M %d %d %d %d %d %d %d %d %u %d %d %d %d %d %d %d %d %d %d %d %d %d %d\n",
                leveltime, k, (int) m->type, m->spawnpoint.x, m->spawnpoint.y, m->spawnpoint.type,
                m->spawnpoint.options, m->x, m->y, m->z, (unsigned) m->angle, m->momx, m->momy, m->momz,
                m->health, m->state ? (int) (m->state - states) : -1, m->tics, m->flags, m->floorz,
                m->ceilingz, m->reactiontime, m->movedir, m->movecount, m->threshold, m->lastlook);
    }
    fflush(mobjs);
}

static FILE *secs;
static fixed_t *was;

static void dump_sectors(int setup)
{
    int i;
    if (!secs)
    {
        const char *path = getenv("ORACLE_SECTORS");
        if (!path || !(secs = fopen(path, "w"))) return;
    }
    if (setup)
    {
        free(was);
        was = calloc(numsectors * 4, sizeof(fixed_t));
    }
    for (i = 0; i < numsectors; i++)
    {
        sector_t *s = &sectors[i];
        fixed_t *w = &was[i * 4];
        if (!setup && w[0] == s->floorheight && w[1] == s->ceilingheight && w[2] == s->lightlevel && w[3] == s->special)
            continue;
        w[0] = s->floorheight;
        w[1] = s->ceilingheight;
        w[2] = s->lightlevel;
        w[3] = s->special;
        fprintf(secs, "%d %d %d %d %d %d\n", leveltime, i, s->floorheight, s->ceilingheight, s->lightlevel, s->special);
    }
    fflush(secs);
}

static void dump(void)
{
    thinker_t *th;
    long long n = 0, sx = 0, sy = 0, sz = 0, shp = 0, sst = 0;
    player_t *pl;
    mobj_t *mo;

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
    if (getenv("ORACLE_MOBJS")) dump_mobjs();
}



void __wrap_G_Ticker(void)
{
    __real_G_Ticker();
    if (gamestate == GS_LEVEL)
    {
        dump();
        if (getenv("ORACLE_SECTORS")) dump_sectors(0);
    }
}

void __wrap_P_SetupLevel(int episode, int map, int playermask, skill_t skill)
{
    __real_P_SetupLevel(episode, map, playermask, skill);
    dump();
    if (getenv("ORACLE_SECTORS")) dump_sectors(1);
}
