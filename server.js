var os = require('os');
var request = require('request');
var morgan = require('morgan');
var bodyParser = require('body-parser');
var flat = require('flat');

var redisAddr = "mycache";
var redisPass = null;
if (process.env.REDIS_ADDR) {
    redisAddr = process.env.REDIS_ADDR;
}
if (process.env.REDIS_PASSWORD) {
    redisPass = process.env.REDIS_PASSWORD;
}
console.log("redisAddr: " + redisAddr);
var express = require('express');
var redis = require('redis').createClient("redis://" + redisAddr, {password: redisPass});

var app = express();
app.use(bodyParser.json());
app.use(morgan("dev"));

// api ------------------------------------------------------------
app.post('/api/bikes', function (req, res) {
    if (req.body.id) {
        res.status(400).send('id field must be empty');
        return;
    }

    redis.incr('nextBikeId', function(err, reply) {
        if (err) {
            res.status(500).send(err);
            return;
        }
        var nextId = reply;
        if (!nextId) {
            res.status(500).send('nextId undefined!');
            return;
        }

        var flattenedBody = flat.flatten(req.body);
        console.log('adding: ' + JSON.stringify(flattenedBody));
        flattenedBody.id = nextId;

        redis.hmset(nextId, flattenedBody, function(err, reply) {
            if (err) {
                res.status(500).send(err);
            }

            res.send(flat.unflatten(flattenedBody));
        });
    });
});

app.get('/api/bikes/:bikeId', function(req, res) {
    if (!req.params.bikeId) {
        res.status(400).send('Must specify bikeId');
        return;
    }

    var keyExists = false;
    redis.hkeys(req.params.bikeId, function(err, reply) {
        if (err) {
            res.status(500).send(err);
            return;
        }
        if (reply.length === 0) {
            res.status(400).send('BikeId "' + req.params.bikeId + '" does not exist.');
            return;
        }
        
        redis.hgetall(req.params.bikeId, function(err, reply) {
            if (err) {
                res.status(500).send(err);
            }

            var unflattenedBody = flat.unflatten(reply);
            res.send(unflattenedBody);
        });
    });
});

app.get('/hello', function(req, res) {
    res.send('hello!');
});

// start server ------------------------------------------------------------
var port = 80;
var server = app.listen(port, function () {
    console.log('Listening on port ' + port);
});

process.on("SIGINT", () => {
    process.exit(130 /* 128 + SIGINT */);
});

process.on("SIGTERM", () => {
    console.log("Terminating...");
    server.close();
});
