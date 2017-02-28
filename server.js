var os = require('os');
var request = require('request');
var morgan = require('morgan');
var bodyParser = require('body-parser');
var flat = require('flat');
var validate = require('validate.js');
var _ = require('underscore');

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
redis.on("end", function() {
    console.log('Redis connection terminated unexpectedly! Shutting down...');
    process.exit(1);
});
redis.on("error", function(err) {
    console.log('Uncaught redis error: ' + err);
});

var app = express();
app.use(bodyParser.json());
app.use(morgan("dev"));

validate.validators.illegal = function(value, options, key, attributes) {
    if (value && options) {
        return "cannot be provided";
    }
}

var incomingBikeSchema = {
    id: {
        illegal: true
    },
    available: {
        illegal: true
    },
    manufacturer: {
        presence: true,
        length: { minimum: 1 }
    },
    model: {
        presence: true,
        length: { minimum: 1 }
    },
    hourlyCost: {
        presence: true,
        numericality: { greaterThan: 0 }
    },
    type: {
        presence: true,
        inclusion: [ "mountain", "road", "tandem" ]
    },
    ownerUserId: {
        presence: true,
        numericality: { greaterThan: 0 }
    },
    suitableHeightInMeters: {
        presence: true,
        numericality: { greaterThan: 0 }
    },
    maximumWeightInKg: {
        presence: true,
        numericality: { greaterThan: 0 }
    }
};

// api ------------------------------------------------------------
app.post('/api/bikes', function (req, res) {
    var validationErrors = validate(req.body, incomingBikeSchema);
    if (validationErrors) {
        res.status(400).send(validationErrors);
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

        var newBike = req.body;
        newBike.id = nextId;
        newBike.available = true;
        
        var flattenedBody = flat.flatten(newBike);
        console.log('adding: ' + JSON.stringify(flattenedBody));

        redis.hmset(nextId, flattenedBody, function(err, reply) {
            if (err) {
                res.status(500).send(err);
            }

            res.send(newBike);
        });
    });
});

app.put('/api/bikes/:bikeId', function(req, res) {
    var validationErrors = validate(req.body, incomingBikeSchema);
    if (validationErrors) {
        res.status(400).send(validationErrors);
        return;
    }

    redis.hgetall(req.params.bikeId, function(err, reply) {
        if (err) {
            res.status(500).send(err);
            return;
        }
        if (reply === null) {
            res.status(400).send('BikeId "' + req.params.bikeId + '" does not exist.');
            return;
        }

        var existingBike = flat.unflatten(reply);
        var newBike = req.body;
        newBike.id = existingBike.id;
        newBike.available = existingBike.available;

        var newFlattenedBike = flat.flatten(newBike);
        console.log("updating: " + JSON.stringify(newFlattenedBike));

        redis.multi()
             .del(req.params.bikeId)
             .hmset(req.params.bikeId, newFlattenedBike)
             .exec(function (err, reply) {
                if (err) {
                    res.status(500).send(err);
                    return;
                }

                res.send(newBike);
             });
    });
});

app.get('/api/bikes/:bikeId', function(req, res) {
    if (!req.params.bikeId) {
        res.status(400).send('Must specify bikeId');
        return;
    }

    redis.hgetall(req.params.bikeId, function(err, reply) {
        if (err) {
            res.status(500).send(err);
        }
        if (reply === null) {
            res.status(400).send('BikeId "' + req.params.bikeId + '" does not exist.');
            return;
        }

        var bike = flat.unflatten(reply);

        // Convert number and boolean fields
        bike.id = parseInt(bike.id);
        bike.available = (bike.available == 'true');
        bike.hourlyCost = parseFloat(bike.hourlyCost);
        bike.ownerUserId = parseInt(bike.ownerUserId);
        bike.suitableHeightInMeters = parseFloat(bike.suitableHeightInMeters);
        bike.maximumWeightInKg = parseFloat(bike.maximumWeightInKg);

        res.send(bike);
    });
});

app.delete('/api/bikes/:bikeId', function(req, res) {
    if (!req.params.bikeId) {
        res.status(400).send('Must specify bikeId');
        return;
    }

    redis.del(req.params.bikeId, function(err, reply) {
        if (err) {
            res.status(500).send(err);
            return;
        }
        if (reply === 0) {
            res.status(400).send('BikeId "' + req.params.bikeId + '" does not exist.');
            return;
        }

        res.sendStatus(200);
    });
});

app.patch('/api/bikes/:bikeId/reserve', function(req, res) {
    if (!req.params.bikeId) {
        res.status(400).send('Must specify bikeId');
        return;
    }

    processReservation(res, req.params.bikeId, "false");
});

app.patch('/api/bikes/:bikeId/clear', function(req, res) {
    if (!req.params.bikeId) {
        res.status(400).send('Must specify bikeId');
        return;
    }

    processReservation(res, req.params.bikeId, "true");
});

function processReservation(httpResponse, bikeId, changeTo) {
    redis.hget(bikeId, "available", function(err, reply) {
        if (err) {
            httpResponse.status(500).send(err);
            return;
        }
        if (reply === null) {
            httpResponse.status(400).send('BikeId "' + bikeId + '" does not exist.');
            return;
        }
        if (reply === changeTo) {
            httpResponse.status(400).send('Invalid reservation change for BikeId "' + bikeId + '"');
            return;
        }

        redis.hset(bikeId, "available", changeTo, function(err, reply) {
            if (err) {
                httpResponse.status(500).send(err);
            }

            httpResponse.sendStatus(200);
        });
    });
}

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
