/*
    LittleJS - The Tiny JavaScript Game Engine That Can!
    MIT License - Copyright 2021 Frank Force

    Engine Features
    - Object oriented system with base class engine object
    - Base class object handles update, physics, collision, rendering, etc
    - Engine helper classes and functions like Vector2, Color, and Timer
    - Super fast rendering system for tile sheets
    - Sound effects audio with zzfx and music with zzfxm
    - Input processing system with gamepad and touchscreen support
    - Tile layer rendering and collision system
    - Particle effect system
    - Medal system tracks and displays achievements
    - Debug tools and debug rendering system
    - Call engineInit() to start it up!
*/

'use strict';

/** Name of engine */
const engineName = 'LittleJS';

/** Version of engine */
const engineVersion = '1.1.25';

/** Frames per second to update objects
 *  @default */
const frameRate = 60;

/** How many seconds each frame lasts, engine uses a fixed time step
 *  @default 1/60 */
const timeDelta = 1/frameRate;

/** Array containing all engine objects */
let engineObjects = [];

/** Array containing only objects that are set to collide with other objects (for optimization) */
let engineObjectsCollide = [];

/** Current update frame, used to calculate time */
let frame = 0;

/** Current engine time since start in seconds, derived from frame */
let time = 0;

/** Actual clock time since start in seconds (not affected by pause or frame rate clamping) */
let timeReal = 0;

/** Is the game paused? Causes time and objects to not be updated. */
let paused = 0;

// Engine internal variables not exposed to documentation
let frameTimeLastMS = 0, frameTimeBufferMS = 0, debugFPS = 0, 
    shrinkTilesX, shrinkTilesY, drawCount, tileImageSize, tileImageSizeInverse;

///////////////////////////////////////////////////////////////////////////////

/** Start up LittleJS engine with your callback functions
 *  @param {Function} gameInit        - Called once after the engine starts up, setup the game
 *  @param {Function} gameUpdate      - Called every frame at 60 frames per second, handle input and update the game state
 *  @param {Function} gameUpdatePost  - Called after physics and objects are updated, setup camera and prepare for render
 *  @param {Function} gameRender      - Called before objects are rendered, draw any background effects that appear behind objects
 *  @param {Function} gameRenderPost  - Called after objects are rendered, draw effects or hud that appear above all objects
 *  @param {String} [tileImageSource] - Tile image to use, everything starts when the image is finished loading
 */
function engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, tileImageSource)
{
    // init engine when tiles load or fail to load
    tileImage.onerror = tileImage.onload = ()=>
    {
        // save tile image info
        tileImageSizeInverse = vec2(1).divide(tileImageSize = vec2(tileImage.width, tileImage.height));
        debug && (tileImage.onload=()=>ASSERT(1)); // tile sheet can not reloaded
        shrinkTilesX = tileBleedShrinkFix/tileImageSize.x;
        shrinkTilesY = tileBleedShrinkFix/tileImageSize.y;

        // setup html
        document.body.appendChild(mainCanvas = document.createElement('canvas'));
        document.body.style = 'margin:0;overflow:hidden;background:#000' +
            ';touch-action:none;user-select:none;-webkit-user-select:none;-moz-user-select:none';
        mainCanvas.style = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)';
        mainContext = mainCanvas.getContext('2d');

        // init stuff and start engine
        debugInit();
        glInit();

        // create overlay canvas for hud to appear above gl canvas
        document.body.appendChild(overlayCanvas = document.createElement('canvas'));
        overlayCanvas.style = mainCanvas.style.cssText;
        overlayContext = overlayCanvas.getContext('2d');
        
        gameInit();
        touchGamepadCreate();
        engineUpdate();
    };

    // main update loop
    const engineUpdate = (frameTimeMS=0)=>
    {
        requestAnimationFrame(engineUpdate);

        // update time keeping
        let frameTimeDeltaMS = frameTimeMS - frameTimeLastMS;
        frameTimeLastMS = frameTimeMS;
        if (debug || showWatermark)
            debugFPS = lerp(.05, 1e3/(frameTimeDeltaMS||1), debugFPS);
        if (debug)
            frameTimeDeltaMS *= keyIsDown(107) ? 5 : keyIsDown(109) ? .2 : 1; // +/- to speed/slow time
        timeReal += frameTimeDeltaMS / 1e3;
        frameTimeBufferMS = min(frameTimeBufferMS + !paused * frameTimeDeltaMS, 50); // clamp incase of slow framerate

        if (paused)
        {
            // do post update even when paused
            inputUpdate();
            debugUpdate();
            gameUpdatePost();
            inputUpdatePost();
        }
        else
        {
            // apply time delta smoothing, improves smoothness of framerate in some browsers
            let deltaSmooth = 0;
            if (frameTimeBufferMS < 0 && frameTimeBufferMS > -9)
            {
                // force an update each frame if time is close enough (not just a fast refresh rate)
                deltaSmooth = frameTimeBufferMS;
                frameTimeBufferMS = 0;
            }
            
            // update multiple frames if necessary in case of slow framerate
            for (;frameTimeBufferMS >= 0; frameTimeBufferMS -= 1e3 / frameRate)
            {
                // update game and objects
                inputUpdate();
                gameUpdate();
                engineObjectsUpdate();

                // do post update
                debugUpdate();
                gameUpdatePost();
                inputUpdatePost();
            }

            // add the time smoothing back in
            frameTimeBufferMS += deltaSmooth;
        }

        if (canvasFixedSize.x)
        {
            // clear set fixed size
            mainCanvas.width  = canvasFixedSize.x;
            mainCanvas.height = canvasFixedSize.y;
            
            // fit to window by adding space on top or bottom if necessary
            const aspect = innerWidth / innerHeight;
            const fixedAspect = mainCanvas.width / mainCanvas.height;
            mainCanvas.style.width  = overlayCanvas.style.width  = aspect < fixedAspect ? '100%' : '';
            mainCanvas.style.height = overlayCanvas.style.height = aspect < fixedAspect ? '' : '100%';
            if (glCanvas)
            {
                glCanvas.style.width  = mainCanvas.style.width;
                glCanvas.style.height = mainCanvas.style.height;
            }
        }
        else
        {
            // clear and set size to same as window
            mainCanvas.width  = min(innerWidth,  canvasMaxSize.x);
            mainCanvas.height = min(innerHeight, canvasMaxSize.y);
        }
        
        // render sort then render while removing destroyed objects
        enginePreRender();
        gameRender();
        engineObjects.sort((a,b)=> a.renderOrder - b.renderOrder);
        for (const o of engineObjects)
            o.destroyed || o.render();
        gameRenderPost();
        medalsRender();
        touchGamepadRender();
        debugRender();
        glCopyToContext(mainContext);

        if (showWatermark)
        {
            // update fps
            overlayContext.textAlign = 'right';
            overlayContext.textBaseline = 'top';
            overlayContext.font = '1em monospace';
            overlayContext.fillStyle = '#000';
            const text = engineName + ' ' + 'v' + engineVersion + ' / ' 
                + drawCount + ' / ' + engineObjects.length + ' / ' + debugFPS.toFixed(1)
                + ' ' + (glEnable ? 'GL' : '2D') ;
            overlayContext.fillText(text, mainCanvas.width-3, 3);
            overlayContext.fillStyle = '#fff';
            overlayContext.fillText(text, mainCanvas.width-2, 2);
            drawCount = 0;
        }
    }

    // set tile image source to load the image and start the engine
    tileImageSource ? tileImage.src = tileImageSource : tileImage.onload();
}

// called by engine to setup render system
function enginePreRender()
{
    // save canvas size and clear canvases
    mainCanvasSize = vec2(overlayCanvas.width = mainCanvas.width, overlayCanvas.height = mainCanvas.height);
    mainContext.imageSmoothingEnabled = !cavasPixelated; // disable smoothing for pixel art
    glPreRender(mainCanvas.width, mainCanvas.height, cameraPos.x, cameraPos.y, cameraScale);
}

///////////////////////////////////////////////////////////////////////////////

/** Calls update on each engine object (recursively if child), removes destroyed objects, and updated time */
function engineObjectsUpdate()
{
    // recursive object update
    const updateObject = (o)=>
    {
        if (!o.destroyed)
        {
            o.update();
            for (const child of o.children)
                updateObject(child);
        }
    }
    for (const o of engineObjects)
        o.parent || updateObject(o);

    // remove destroyed objects
    engineObjects = engineObjects.filter(o=>!o.destroyed);
    engineObjectsCollide = engineObjectsCollide.filter(o=>!o.destroyed);

    // increment frame and update time
    time = ++frame / frameRate;
}

/** Detroy and remove all objects that are not persistent or descendants of a persistent object */
function engineObjectsDestroy()
{
    for (const o of engineObjects)
        o.persistent || o.parent || o.destroy();
    engineObjects = engineObjects.filter(o=>!o.destroyed);
}

/** Triggers a callback for each object within a given area
 *  @param {Vector2} [pos]                 - Center of test area
 *  @param {Number} [size]                 - Radius of circle if float, rectangle size if Vector2
 *  @param {Function} [callbackFunction]   - Calls this function on every object that passes the test
 *  @param {Array} [objects=engineObjects] - List of objects to check */
function engineObjectsCallback(pos, size, callbackFunction, objects=engineObjects)
{
    if (!pos)
    {
        // all objects
        for (const o of objects)
            callbackFunction(o);
    }
    else if (size.x != undefined)
    {
        // aabb test
        for (const o of objects)
            isOverlapping(pos, size, o.pos, o.size) && callbackFunction(o);
    }
    else
    {
        // circle test
        const sizeSquared = size*size;
        for (const o of objects)
            pos.distanceSquared(o.pos) < sizeSquared && callbackFunction(o);
    }
}